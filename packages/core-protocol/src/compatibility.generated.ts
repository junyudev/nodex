import type { components } from "./generated";

export const CORE_CLIENT_REQUIREMENTS = {
  "transport": {
    "min": 14,
    "max": 14
  },
  "event_version": 11,
  "modules": [
    {
      "module": "library",
      "contract_version": 55
    },
    {
      "module": "database",
      "contract_version": 27
    },
    {
      "module": "owned_document",
      "contract_version": 16
    },
    {
      "module": "project_workspace",
      "contract_version": 48
    },
    {
      "module": "automation",
      "contract_version": 10
    },
    {
      "module": "store_administration",
      "contract_version": 9
    },
    {
      "module": "query",
      "contract_version": 4
    }
  ],
  "accepted_store_formats": [
    {
      "lineage": "nodex-rust-core",
      "version": 191,
      "schema_fingerprint": "9289768b95a37b1f6014b235820be98e35c2a8e48e09b6a46b2ec15f4fb8e4dd"
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
