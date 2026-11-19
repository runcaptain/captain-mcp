import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { selectFields } from '../dist/responseFields.js';
import { registerChunkTools } from '../dist/chunkTools.js';
import { registerDocumentTools } from '../dist/documentTools.js';
import { registerParseTools, summarizeJob } from '../dist/parseTools.js';
import { runWithConfig } from '../dist/captainClient.js';

// Example responses copied verbatim from the API reference (docs.captain.dev/reference/v3/...),
// so the projection is checked against the shapes the API documents, not shapes made up for the test.

// GET /v3/collections/{collection_name}/documents/{document_id}
const GET_DOCUMENT = Object.freeze({
  "document_id": "doc_climate_agriculture_2024",
  "collection_name": "research_library",
  "chunk_count": 42,
  "metadata": {
    "filename": "climate-agriculture-impact-report.pdf",
    "file_type": "pdf",
    "file_size": 1323494,
    "mime_type": "application/pdf",
    "uri": "s3://research-library/climate/agriculture-impact-report.pdf",
    "summary": "Research report on the effects of heat, drought, and precipitation changes on crop yields.",
    "tags": [
      "climate",
      "agriculture",
      "crop-yields"
    ],
    "indexing_status": "completed",
    "created_at": "2024-05-20T10:15:30Z",
    "indexed_at": "2024-05-21T08:00:00Z"
  },
  "chunks": [
    {
      "chunk_id": "chunk_agri_report_001",
      "document_id": "doc_climate_agriculture_2024",
      "text": "Recent studies show that climate change affects crop yields through heat stress, shifting precipitation, and more frequent extreme weather events.",
      "location": {
        "page_start": 12,
        "page_end": 13,
        "chunk_index": 4,
        "parent_chunk_index": 1
      },
      "regions": [
        {
          "type": "text",
          "text": "Projected maize yield declines under high temperature scenarios",
          "page": 12,
          "bbox": {
            "x": 0.18,
            "y": 0.24,
            "width": 0.62,
            "height": 0.08
          },
          "confidence": "high"
        },
        {
          "type": "chart",
          "page": 13,
          "bbox": {
            "x": 0.12,
            "y": 0.31,
            "width": 0.76,
            "height": 0.42
          },
          "confidence": "medium",
          "image_url": "https://storage.example.com/previews/climate-agriculture-chart-p13.png",
          "description": "Chart comparing projected crop yield changes by region."
        }
      ],
      "custom_metadata": {
        "review_status": "peer_reviewed",
        "topic": "agriculture"
      },
      "metadata": {
        "section": "Projected yield impacts",
        "page_count": 2
      }
    },
    {
      "chunk_id": "chunk_agri_report_002",
      "document_id": "doc_climate_agriculture_2024",
      "text": "Adaptation measures include drought resistant seed varieties, improved irrigation scheduling, and soil moisture monitoring.",
      "location": {
        "page_start": 14,
        "page_end": 14,
        "chunk_index": 5,
        "parent_chunk_index": 1
      },
      "regions": [
        {
          "type": "text",
          "text": "Adaptation measures include drought resistant seed varieties",
          "page": 14,
          "bbox": {
            "x": 0.16,
            "y": 0.19,
            "width": 0.68,
            "height": 0.06
          },
          "confidence": "high"
        }
      ],
      "custom_metadata": {
        "review_status": "peer_reviewed",
        "topic": "adaptation"
      },
      "metadata": {
        "section": "Adaptation strategies"
      }
    }
  ],
  "warnings": []
});

// GET /v3/collections/{collection_name}/chunks
const LIST_CHUNKS = Object.freeze({
  "collection_name": "research_library",
  "document_id": "doc_climate_agriculture_2024",
  "total_results": 42,
  "limit": 2,
  "chunks": [
    {
      "chunk_id": "chunk_agri_report_001",
      "document_id": "doc_climate_agriculture_2024",
      "text": "Recent studies show that climate change affects crop yields through heat stress, shifting precipitation, and more frequent extreme weather events.",
      "location": {
        "page_start": 12,
        "page_end": 13,
        "chunk_index": 4,
        "parent_chunk_index": 1
      },
      "regions": [
        {
          "type": "text",
          "text": "Projected maize yield declines under high temperature scenarios",
          "page": 12,
          "bbox": {
            "x": 0.18,
            "y": 0.24,
            "width": 0.62,
            "height": 0.08
          },
          "confidence": "high"
        },
        {
          "type": "chart",
          "page": 13,
          "bbox": {
            "x": 0.12,
            "y": 0.31,
            "width": 0.76,
            "height": 0.42
          },
          "confidence": "medium",
          "image_url": "https://storage.example.com/previews/climate-agriculture-chart-p13.png",
          "description": "Chart comparing projected crop yield changes by region."
        }
      ],
      "custom_metadata": {
        "review_status": "peer_reviewed",
        "topic": "agriculture"
      },
      "metadata": {
        "section": "Projected yield impacts",
        "page_count": 2
      }
    },
    {
      "chunk_id": "chunk_agri_report_002",
      "document_id": "doc_climate_agriculture_2024",
      "text": "Adaptation measures include drought resistant seed varieties, improved irrigation scheduling, and soil moisture monitoring.",
      "location": {
        "page_start": 14,
        "page_end": 14,
        "chunk_index": 5,
        "parent_chunk_index": 1
      },
      "regions": [
        {
          "type": "text",
          "text": "Adaptation measures include drought resistant seed varieties",
          "page": 14,
          "bbox": {
            "x": 0.16,
            "y": 0.19,
            "width": 0.68,
            "height": 0.06
          },
          "confidence": "high"
        }
      ],
      "custom_metadata": {
        "review_status": "peer_reviewed",
        "topic": "adaptation"
      },
      "metadata": {
        "section": "Adaptation strategies"
      }
    }
  ],
  "cursor": 0,
  "next_cursor": 2,
  "warnings": []
});

// POST /v3/collections/{collection_name}/query
const QUERY_V3 = Object.freeze({
  "query": "payment authorization requirements",
  "results": [
    {
      "chunk_id": "f4a91c7e8b2d4a0c9e6f13b5a8d02744:0",
      "score": 0.09523809523809523,
      "text": "# Payment authorization form\n\nI authorize the merchant to charge the card on file for approved purchases.\n\nAmount authorized: <empty>\nCardholder email: <empty>\nProduct or service: <empty>\n\n## Card information\n\nCard type:\n[ ] Visa\n[ ] Mastercard\n[ ] American Express\n[ ] Other <empty>\n\n## Recurring payments\n\nCharge frequency: <empty>\nPayment amount: <empty>\nCancellation terms: <empty>",
      "modality": "pdf",
      "match_sources": [
        "content_embedding",
        "keyword",
        "ocr"
      ],
      "document": {
        "id": "f4a91c7e8b2d4a0c9e6f13b5a8d02744",
        "filename": "payment-authorization-form.pdf",
        "source": {
          "type": "file",
          "uri": "captain://org_example/users/user_example/collections/customer_forms/payment-authorization-form.pdf",
          "mime_type": null
        }
      },
      "location": {
        "page_start": 1,
        "page_end": 1,
        "chunk_index": 0,
        "parent_chunk_index": 0,
        "start_seconds": null,
        "end_seconds": null,
        "sheet_name": null,
        "row_start": null,
        "row_end": null,
        "col_start": null,
        "col_end": null
      },
      "media": null,
      "metadata": {
        "vectorScore": 0.42747492,
        "bm25Score": 2.2132137,
        "rrfScore": 0.09523809523809523,
        "pageStart": 1,
        "pageEnd": 1
      },
      "custom_metadata": {
        "document_type": "authorization_form",
        "review_status": "approved"
      },
      "rerank_score": null,
      "boost": null
    }
  ],
  "total_results": 1,
  "limit": 3,
  "rerank": {
    "used": false,
    "reason": "disabled",
    "model": null,
    "candidate_limit": null
  },
  "timing": {
    "stages": [
      {
        "name": "preparation",
        "start_ms": 0,
        "duration_ms": 13
      },
      {
        "name": "embedding",
        "start_ms": 13,
        "duration_ms": 37
      },
      {
        "name": "retrieval",
        "start_ms": 50,
        "duration_ms": 22
      },
      {
        "name": "fusion",
        "start_ms": 72,
        "duration_ms": 1
      },
      {
        "name": "hydration",
        "start_ms": 73,
        "duration_ms": 113
      }
    ],
    "total_ms": 186
  },
  "warnings": [],
  "execution_time_ms": 186,
  "request_id": "req_1787610044_2c8f41ab",
  "query_id": "019a0e2a-7b31-7c4e-9d2f-3a8c1e5b6f90",
  "exclude_chunk_types": [],
  "boost": []
});

// GET /v3/parse/jobs/{job_id}
const PARSE_JOB = Object.freeze({
  "job_id": "prs_c9f0f895fb98ab9159f51fd0297e236d",
  "type": "spreadsheet",
  "status": "completed",
  "created_at": "2026-10-01T15:04:05Z",
  "file": {
    "name": "ledger.xlsx",
    "type": "xlsx",
    "pages": null
  },
  "options": {
    "include_images": false,
    "include_verified_facts": true,
    "include_tags_summary": false,
    "input": "captain://upl_5d41402abc4b2a76b9719d911017c592"
  },
  "chunker_version": "production:412",
  "usage": {
    "pages_basic": 0,
    "pages_advanced": 0,
    "credits": 0
  },
  "chunk_count": 2,
  "chunks": [
    {
      "chunk_id": "prs_c9f0f895fb98ab9159f51fd0297e236d:0:0",
      "chunk_index": 0,
      "parent_chunk_index": 0,
      "text": "# Sheet: Intake, sheet information\n| Field | Value |\n| --- | --- |\n| Prepared by | Operations |\n| Season | 2025 |",
      "tokens": 31,
      "location": {
        "sheet_name": "Intake",
        "row_start": 1,
        "row_end": 3,
        "col_start": 1,
        "col_end": 2
      },
      "chunk_type": null,
      "sheet": {
        "section": "sheet information",
        "columns": [
          "Field",
          "Value"
        ],
        "row_role": "sheet_header",
        "structured_fields": {
          "Field": "Prepared by",
          "Value": "Operations"
        }
      }
    },
    {
      "chunk_id": "prs_c9f0f895fb98ab9159f51fd0297e236d:1:0",
      "chunk_index": 0,
      "parent_chunk_index": 1,
      "text": "# Sheet: Intake, section 1 (L-1000)\n| Load | Farm | Wheat / Tonnes | Wheat / Price/t |\n| --- | --- | --- | --- |\n| L-1000 | Mill Farm | 16 | 250 |\n| L-1001 | Ridge Farm | 22 | 245 |",
      "tokens": 58,
      "location": {
        "sheet_name": "Intake",
        "row_start": 7,
        "row_end": 8,
        "col_start": 1,
        "col_end": 4
      },
      "chunk_type": null,
      "sheet": {
        "section": "section 1 (L-1000)",
        "columns": [
          "Load",
          "Farm",
          "Wheat / Tonnes",
          "Wheat / Price/t"
        ],
        "row_role": null,
        "structured_fields": {
          "Load": "L-1000",
          "Farm": "Mill Farm",
          "Wheat / Tonnes": "16",
          "Wheat / Price/t": "250"
        }
      },
      "verified_facts": {
        "row_count": 2,
        "columns": {
          "Wheat / Tonnes": {
            "min": 16,
            "max": 22
          },
          "Wheat / Price/t": {
            "min": 245,
            "max": 250
          }
        }
      }
    }
  ],
  "result_url": "https://results.captain.dev/parse/prs_c9f0f895fb98ab9159f51fd0297e236d/result.json?signature=abc123",
  "result_expires_at": "2026-10-08T15:04:40Z",
  "error": null,
  "completed_at": "2026-10-01T15:04:40Z"
});

const clone = (v) => structuredClone(v);
const call = (map, name, args) => runWithConfig({ apiKey: 'synthetic' }, () => map.get(name).handler(args));
const parse = (r) => JSON.parse(r.content[0].text);

function handlers() {
  const map = new Map();
  const server = { registerTool: (name, definition, handler) => map.set(name, { definition, handler }) };
  registerChunkTools(server);
  registerDocumentTools(server);
  registerParseTools(server);
  return map;
}

function mockFetch(t, body) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), body: options?.body });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return seen;
}

// ── selectFields on the API reference example responses ──────────

test('get document: chunks keep the requested keys and their ids, the envelope is untouched', () => {
  const input = clone(GET_DOCUMENT);
  const out = selectFields(input, 'chunks', ['text', 'location'], ['chunk_id', 'document_id']);
  assert.deepEqual(input, GET_DOCUMENT, 'the input is not mutated');
  for (const chunk of out.chunks) assert.deepEqual(Object.keys(chunk).sort(), ['chunk_id', 'document_id', 'location', 'text']);
  assert.equal(out.chunks[0].text, GET_DOCUMENT.chunks[0].text);
  for (const key of ['document_id', 'collection_name', 'chunk_count', 'metadata', 'warnings']) {
    assert.deepEqual(out[key], GET_DOCUMENT[key], key);
  }
  assert.deepEqual(out.fields_applied, { omitted: ['custom_metadata', 'metadata', 'regions'] });
});

test('list chunks: paging keys survive so the caller can still fetch the next page', () => {
  const out = selectFields(LIST_CHUNKS, 'chunks', ['text'], ['chunk_id', 'document_id']);
  assert.equal(out.total_results, 42);
  assert.equal(out.next_cursor, 2);
  assert.equal(out.cursor, 0);
  assert.equal(out.chunks.length, 2);
});

test('v3 query: only results are projected, not timing.stages, boost or the other lists', () => {
  const out = selectFields(QUERY_V3, 'results', ['text', 'score'], ['chunk_id', 'document.id']);
  assert.deepEqual(out.results, [{
    chunk_id: QUERY_V3.results[0].chunk_id, score: QUERY_V3.results[0].score, text: QUERY_V3.results[0].text,
    document: { id: QUERY_V3.results[0].document.id },
  }]);
  assert.deepEqual(out.timing, QUERY_V3.timing);
  for (const key of ['boost', 'warnings', 'exclude_chunk_types', 'rerank', 'query_id', 'request_id', 'total_results']) {
    assert.deepEqual(out[key], QUERY_V3[key], key);
  }
});

test('parse job: chunk_id is kept and chunks_truncated from summarizeJob survives', () => {
  const out = selectFields(summarizeJob(PARSE_JOB, 1), 'chunks', ['text'], ['chunk_id']);
  assert.deepEqual(out.chunks, [{ chunk_id: PARSE_JOB.chunks[0].chunk_id, text: PARSE_JOB.chunks[0].text }]);
  assert.deepEqual(out.chunks_truncated, { shown: 1, total: 2, full_result: 'result_url' });
  assert.equal(out.result_url, PARSE_JOB.result_url);
});

test('a requested key no item carries is named missing, including dotted keys', () => {
  const out = selectFields(QUERY_V3, 'results', ['text', 'socre', 'document.filename'], ['chunk_id']);
  assert.deepEqual(out.fields_applied.missing, ['socre', 'document.filename']);
});

test('a key carried by only some items is not missing', () => {
  const out = selectFields(PARSE_JOB, 'chunks', ['verified_facts'], ['chunk_id']);
  assert.equal(out.fields_applied.missing, undefined);
  assert.deepEqual(out.chunks[1].verified_facts, PARSE_JOB.chunks[1].verified_facts);
  assert.deepEqual(out.chunks[0], { chunk_id: PARSE_JOB.chunks[0].chunk_id });
});

test('a nested id is kept alone, and the whole parent when it is requested', () => {
  const out = selectFields(QUERY_V3, 'results', ['text'], ['chunk_id', 'document.id']);
  assert.deepEqual(out.results[0].document, { id: 'f4a91c7e8b2d4a0c9e6f13b5a8d02744' });
  assert.ok(out.fields_applied.omitted.includes('document'), 'the rest of document was removed, so it is named');
  const full = selectFields(QUERY_V3, 'results', ['text', 'document'], ['chunk_id', 'document.id']);
  assert.deepEqual(full.results[0].document, QUERY_V3.results[0].document);
  const absent = selectFields({ results: [{ chunk_id: 'a', text: 't', document: null }] }, 'results', ['text'], ['document.id']);
  assert.deepEqual(absent.results[0], { text: 't' });
});

test('inherited properties such as constructor are reported missing', () => {
  const out = selectFields(GET_DOCUMENT, 'chunks', ['text', 'constructor', 'toString'], ['chunk_id']);
  assert.deepEqual(out.fields_applied.missing, ['constructor', 'toString']);
});

test('no notice when nothing was removed or missing', () => {
  const out = selectFields({ chunks: [{ chunk_id: 'a', text: 't' }] }, 'chunks', ['text'], ['chunk_id']);
  assert.equal('fields_applied' in out, false);
});

test('an empty page keeps its shape and names nothing missing', () => {
  const page = { total_results: 0, chunks: [], next_cursor: null };
  assert.deepEqual(selectFields(page, 'chunks', ['text'], ['chunk_id']), page);
});

test('without fields, or on an unexpected shape, the response is returned as is', () => {
  assert.equal(selectFields(GET_DOCUMENT, 'chunks', undefined), GET_DOCUMENT);
  assert.equal(selectFields(GET_DOCUMENT, 'chunks', []), GET_DOCUMENT);
  const noList = { chunks: null, status: 'running' };
  assert.equal(selectFields(noList, 'chunks', ['text']), noList);
  assert.equal(selectFields('plain text', 'chunks', ['text']), 'plain text');
  assert.equal(selectFields(null, 'chunks', ['text']), null);
  const listPayload = [{ text: 'a' }];
  assert.equal(selectFields(listPayload, 'chunks', ['text']), listPayload);
});

test('non-object items pass through untouched', () => {
  const out = selectFields({ chunks: ['raw', { chunk_id: 'a', text: 't', x: 1 }] }, 'chunks', ['text'], ['chunk_id']);
  assert.deepEqual(out.chunks, ['raw', { chunk_id: 'a', text: 't' }]);
});

// ── the four tools ───────────────────────────────────────────────

const TOOLS = ['captain_search_v3', 'captain_get_document', 'captain_list_chunks', 'captain_get_parse_job'];

test('the four tools accept fields, refuse an empty list, and describe it without em dashes', () => {
  const map = handlers();
  for (const name of TOOLS) {
    const schema = z.object(map.get(name).definition.inputSchema);
    const field = map.get(name).definition.inputSchema.fields;
    assert.ok(field, `${name} has fields`);
    assert.doesNotMatch(field.description, /—/);
    assert.equal(schema.shape.fields.safeParse(['text']).success, true, name);
    assert.equal(schema.shape.fields.safeParse([]).success, false, name);
    assert.equal(schema.shape.fields.safeParse(undefined).success, true, name);
  }
});

test('search_v3 projects results and does not send fields to the API', async (t) => {
  const seen = mockFetch(t, QUERY_V3);
  const out = parse(await call(handlers(), 'captain_search_v3', { collection: 'c', query: 'q', fields: ['text'] }));
  assert.deepEqual(Object.keys(out.results[0]).sort(), ['chunk_id', 'document', 'text']);
  assert.deepEqual(out.results[0].document, { id: QUERY_V3.results[0].document.id }, 'the document id survives');
  assert.deepEqual(out.timing, QUERY_V3.timing);
  assert.equal('fields' in JSON.parse(seen[0].body), false);
});

test('get_document projects chunks; without fields the response is byte-identical', async (t) => {
  mockFetch(t, GET_DOCUMENT);
  const map = handlers();
  const full = await call(map, 'captain_get_document', { collection: 'c', document_id: 'd' });
  assert.equal(full.content[0].text, JSON.stringify(GET_DOCUMENT, null, 2));
  const out = parse(await call(map, 'captain_get_document', { collection: 'c', document_id: 'd', fields: ['text'] }));
  assert.deepEqual(Object.keys(out.chunks[0]).sort(), ['chunk_id', 'document_id', 'text']);
  assert.ok(out.fields_applied.omitted.includes('regions'));
});

test('list_chunks projects chunks and keeps next_cursor', async (t) => {
  mockFetch(t, LIST_CHUNKS);
  const out = parse(await call(handlers(), 'captain_list_chunks', { collection: 'c', document_id: 'd', fields: ['location'] }));
  assert.equal(out.next_cursor, 2);
  assert.deepEqual(Object.keys(out.chunks[0]).sort(), ['chunk_id', 'document_id', 'location']);
});

test('get_parse_job applies max_chunks first, then fields', async (t) => {
  mockFetch(t, PARSE_JOB);
  const out = parse(await call(handlers(), 'captain_get_parse_job', { job_id: 'prs_1', max_chunks: 1, fields: ['tokens'] }));
  assert.deepEqual(out.chunks, [{ chunk_id: PARSE_JOB.chunks[0].chunk_id, tokens: 31 }]);
  assert.equal(out.chunks_truncated.total, 2);
});

test('an API error is thrown, never projected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"detail":"not found"}', { status: 404 }));
  await assert.rejects(
    call(handlers(), 'captain_get_document', { collection: 'c', document_id: 'd', fields: ['text'] }),
    /Captain API error \(404\)/,
  );
});
