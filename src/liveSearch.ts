import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "note";
}

export function registerLiveSearchTools(server: McpServer): void {
  // ── captain_save ───────────────────────────────────────────
  server.registerTool(
    "captain_save",
    {
      title: "Save a project note to a Captain search collection",
      description:
        "Save a short note (decision, gotcha, design constraint, bug repro, todo) to a Captain collection so it becomes searchable later. " +
        "Use this to build a persistent, cross-session search index for a coding project. " +
        "The collection is typically named after the project/repo. " +
        "If the collection doesn't exist, it will be created automatically.",
      inputSchema: {
        collection: z.string().describe("Search collection name — usually the project/repo basename"),
        note: z.string().describe("The note content. Be concise. Include the 'why', not just the 'what'."),
        type: z.enum(["decision", "bug", "gotcha", "todo", "note"]).optional().describe("Note category (default: note)"),
        tags: z.array(z.string()).optional().describe("Optional tags for later filtering"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const timestamp = new Date().toISOString();
      const type = params.type || "note";
      const tags = params.tags || [];
      const filename = `note-${timestamp.replace(/[:.]/g, "-")}-${slugify(params.note.slice(0, 48))}.txt`;
      const header = `type: ${type}\ndate: ${timestamp}\ntags: ${tags.join(", ")}\n---\n\n`;
      const body = {
        text: header + params.note,
        filename,
        processing_type: "basic" as const,
      };

      const endpoint = `collections/${encodeURIComponent(params.collection)}/index/text`;
      let data: any;
      try {
        data = await captainFetch(config, endpoint, { method: "POST", body });
      } catch (err: any) {
        if (String(err.message).includes("404")) {
          log(`Collection '${params.collection}' missing; creating and retrying.`);
          await captainFetch(config, `collections/${encodeURIComponent(params.collection)}`, { method: "PUT", body: {} });
          data = await captainFetch(config, endpoint, { method: "POST", body });
        } else {
          throw err;
        }
      }

      return textResult(
        `Note saved to '${params.collection}'.\n` +
        `  type: ${type}\n` +
        `  date: ${timestamp}\n` +
        `  filename: ${filename}\n` +
        `  job_id: ${data.job_id}\n\n` +
        `Indexing runs in the background; the note becomes findable once the job completes.`
      );
    }
  );

  // ── captain_find ───────────────────────────────────────────
  server.registerTool(
    "captain_find",
    {
      title: "Find previously-saved project notes in a Captain search collection",
      description:
        "Find previously-saved notes in a Captain collection via semantic search. " +
        "Use this at session start or when the user references past work (\"what did we decide about X\", " +
        "\"where were we on Y\"). Results are ranked by relevance; timestamps are surfaced so you can judge staleness.",
      inputSchema: {
        collection: z.string().describe("Search collection name — usually the project/repo basename"),
        query: z.string().describe("What you're trying to find — a topic, decision, or keyword"),
        top_k: z.number().optional().describe("Number of notes to return (default 5)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body = {
        query: params.query,
        inference: false,
        top_k: params.top_k ?? 5,
        rerank: true,
        rerank_model: "gemini",
      };
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/query`, { method: "POST", body });
      const results = data.search_results || data.results || [];
      if (results.length === 0) return textResult(`No notes found in '${params.collection}' for: ${params.query}`);

      const formatted = results
        .map((r: any, i: number) => {
          const source = r.filename || r.document_id || "Unknown";
          const score = r.score?.toFixed(3) ?? "N/A";
          const content = r.content || r.text || r.chunk || "";
          const dateMatch = typeof source === "string" ? source.match(/note-(\d{4}-\d{2}-\d{2})/) : null;
          const dateLabel = dateMatch ? dateMatch[1] : "unknown date";
          return `[${i + 1}] ${dateLabel} (score: ${score}) ${source}\n${content}`;
        })
        .join("\n\n---\n\n");

      return textResult(`Found ${results.length} note${results.length === 1 ? "" : "s"} in '${params.collection}':\n\n${formatted}`);
    }
  );
}
