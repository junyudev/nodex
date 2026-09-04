import type { components } from "./generated";

export const CORE_CLIENT_REQUIREMENTS = {
  "transport": {
    "min": 12,
    "max": 12
  },
  "event_version": 10,
  "modules": [
    {
      "module": "library",
      "contract_version": 51
    },
    {
      "module": "database",
      "contract_version": 25
    },
    {
      "module": "owned_document",
      "contract_version": 13
    },
    {
      "module": "project_workspace",
      "contract_version": 21
    },
    {
      "module": "automation",
      "contract_version": 5
    },
    {
      "module": "store_administration",
      "contract_version": 8
    }
  ],
  "accepted_store_formats": [
    {
      "lineage": "nodex-rust-core",
      "version": 159,
      "schema_fingerprint": "6f27a506b4572a15d3bfc544265972fb282e5e8da3cf48ece81a418464c8483a"
    }
  ]
} as const satisfies components["schemas"]["CoreClientRequirements"];

export const CORE_TRANSPORT_BUDGETS = {
  "ordinary_json_request_bytes": 2097152,
  "ordinary_json_response_bytes": 16777216,
  "event_frame_bytes": 2359296,
  "document_json_request_bytes": 67108864,
  "document_response_bytes": 25165832,
  "file_blob_bytes": 67108864,
  "managed_blob_bytes": 268435456,
  "request_deadline_min_ms": 250,
  "request_deadline_max_ms": 300000,
  "interactive_request_deadline_ms": 20000,
  "background_request_deadline_ms": 60000,
  "maintenance_request_deadline_ms": 120000
} as const satisfies components["schemas"]["CoreTransportBudgets"];
