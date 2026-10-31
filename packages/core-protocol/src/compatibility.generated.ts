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
      "contract_version": 56
    },
    {
      "module": "database",
      "contract_version": 28
    },
    {
      "module": "owned_document",
      "contract_version": 17
    },
    {
      "module": "project_workspace",
      "contract_version": 52
    },
    {
      "module": "automation",
      "contract_version": 11
    },
    {
      "module": "store_administration",
      "contract_version": 9
    },
    {
      "module": "query",
      "contract_version": 5
    }
  ],
  "accepted_store_formats": [
    {
      "lineage": "nodex-rust-core",
      "version": 194,
      "schema_fingerprint": "195f0f1e2e34c6e80a73ffe4b2482eafc166eef5a1a417fda32667585c6e3e00"
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
