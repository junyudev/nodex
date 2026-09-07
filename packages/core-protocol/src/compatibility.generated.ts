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
      "contract_version": 53
    },
    {
      "module": "database",
      "contract_version": 26
    },
    {
      "module": "owned_document",
      "contract_version": 14
    },
    {
      "module": "project_workspace",
      "contract_version": 29
    },
    {
      "module": "automation",
      "contract_version": 8
    },
    {
      "module": "store_administration",
      "contract_version": 8
    },
    {
      "module": "query",
      "contract_version": 3
    }
  ],
  "accepted_store_formats": [
    {
      "lineage": "nodex-rust-core",
      "version": 165,
      "schema_fingerprint": "460130364dab6853a08a49891f016fce7a93a824baebf8ac6e4f9ad5ac9e7c7e"
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
