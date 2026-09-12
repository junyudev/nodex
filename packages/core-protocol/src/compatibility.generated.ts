import type { components } from "./generated";

export const CORE_CLIENT_REQUIREMENTS = {
  "transport": {
    "min": 13,
    "max": 13
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
      "contract_version": 15
    },
    {
      "module": "project_workspace",
      "contract_version": 32
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
      "version": 170,
      "schema_fingerprint": "7b038044ec658e42571fa0c2417723ae60b1225df8e87c7929d171f35e71d0ad"
    }
  ]
} as const satisfies components["schemas"]["CoreClientRequirements"];

export const CORE_TRANSPORT_BUDGETS = {
  "document_metadata_bytes": 8388608,
  "document_content_bytes": 16777216,
  "document_state_vector_bytes": 65536,
  "document_update_bytes": 2097152,
  "recovery_bundle_bytes": 33554432,
  "recovery_manifest_bytes": 262144,
  "recovery_manifest_depth": 32,
  "recovery_manifest_nodes": 100000,
  "recovery_sections": 4096,
  "recovery_export_bytes": 33816588,
  "recovery_preview_bytes": 524288,
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
