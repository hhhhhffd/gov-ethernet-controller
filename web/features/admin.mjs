import { apiAliases, unwrapCollection } from "../core/api.mjs";

const RESOURCE_PATHS = Object.freeze({
  districts: "catalogs/districts",
  technologies: "catalogs/technologies",
  schedule: "schedules",
});

const ADMIN_RESOURCES = Object.freeze([
  {
    key: "organizations",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "school_id", "name", "district", "district_id", "address", "latitude", "longitude", "contact_name", "contact_phone", "contact_role", "contact_position", "contact_email", "active"],
    displayFields: ["name", "district", "address", "active"],
  },
  {
    key: "providers",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "name", "support_contact", "active"],
    displayFields: ["name", "support_contact", "active"],
  },
  {
    key: "lines",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "organization_id", "provider_id", "role", "technology", "technology_id", "status"],
    displayFields: ["organization_name", "provider_name", "role", "technology", "status"],
  },
  {
    key: "monitoring-points",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "line_id", "location", "is_primary", "active"],
    displayFields: ["location", "is_primary", "active"],
  },
  {
    key: "users",
    capability: "admin.users",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "username", "role", "password", "disabled", "scopes"],
    displayFields: ["username", "role", "disabled"],
  },
  {
    key: "devices",
    capability: "admin.devices",
    supportsCreate: false,
    supportsUpdate: true,
    supportsRegistration: true,
    writableFields: ["display_name"],
    registrationFields: ["device_id", "monitoring_point_id", "agent_version", "display_name"],
    displayFields: ["display_name", "agent_version", "last_seen", "blocked"],
  },
  {
    key: "schedule",
    capability: "admin.manage",
    supportsCreate: false,
    supportsUpdate: true,
    writableFields: ["tests_per_day", "performance_tests_per_day", "jitter_minutes", "light_checks_between"],
    displayFields: ["tests_per_day", "performance_tests_per_day", "jitter_minutes", "light_checks_between"],
  },
  {
    key: "policies",
    capability: "admin.policies",
    supportsCreate: true,
    supportsUpdate: false,
    writableFields: ["scope_type", "scope_id", "valid_from", "valid_to", "version", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min", "confirm_count", "confirm_minutes", "confirm_duration_minutes", "recovery_count", "recovery_minutes", "freshness_seconds", "reason"],
    displayFields: ["scope_type", "version", "valid_from", "valid_to", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min"],
  },
  {
    key: "contracts",
    capability: "admin.policies",
    supportsCreate: true,
    supportsUpdate: false,
    writableFields: ["line_id", "valid_from", "valid_to", "contract_no", "contract_date", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min", "reason"],
    displayFields: ["contract_no", "contract_date", "valid_from", "valid_to", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min"],
  },
  {
    key: "districts",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "name", "active"],
    displayFields: ["name", "active"],
  },
  {
    key: "technologies",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["id", "name", "active"],
    displayFields: ["name", "active"],
  },
  {
    key: "agent-versions",
    capability: "admin.manage",
    supportsCreate: true,
    supportsUpdate: true,
    writableFields: ["version", "recommended", "minimum_supported", "release_at", "checksum", "artifact_url", "active"],
    displayFields: ["version", "recommended", "minimum_supported", "release_at", "active"],
  },
]);

const DEVICE_ACTIONS = Object.freeze(new Set(["block", "unblock", "rotate-token"]));
const IMPACT_POLICY_FIELDS = Object.freeze(["download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min", "confirm_count", "confirm_minutes", "confirm_duration_minutes", "recovery_count", "recovery_minutes", "freshness_seconds"]);
const IMPACT_CONTRACT_FIELDS = Object.freeze(["download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min"]);

function pathFor(resource) {
  return RESOURCE_PATHS[resource] || resource;
}

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}

function definitionFor(resource) {
  const definition = ADMIN_RESOURCES.find((item) => item.key === resource);
  if (!definition) throw contractError("unknown_admin_resource", `Unknown admin resource: ${resource}`);
  return definition;
}

function pickFields(payload, fields) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw contractError("invalid_admin_payload", "Admin payload must be an object");
  }
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined)
    .map((field) => [field, payload[field]]));
}

export function adminResourceDefinitions() {
  return ADMIN_RESOURCES.map((resource) => ({
    ...resource,
    mutable: resource.supportsCreate || resource.supportsUpdate,
    writableFields: [...resource.writableFields],
    displayFields: [...resource.displayFields],
    ...(resource.registrationFields ? { registrationFields: [...resource.registrationFields] } : {}),
  }));
}

export function adminResourceDefinition(resource) {
  const definition = definitionFor(resource);
  return {
    ...definition,
    mutable: definition.supportsCreate || definition.supportsUpdate,
    writableFields: [...definition.writableFields],
    displayFields: [...definition.displayFields],
    ...(definition.registrationFields ? { registrationFields: [...definition.registrationFields] } : {}),
  };
}

export function writableAdminPayload(resource, payload, { id = "", operation = "update" } = {}) {
  const definition = definitionFor(resource);
  const supported = operation === "create" ? definition.supportsCreate : definition.supportsUpdate;
  if (!supported) throw contractError("unsupported_admin_operation", `${resource} does not support ${operation}`);
  const result = pickFields(payload, definition.writableFields);
  if (id && definition.writableFields.includes("id")) result.id = id;
  return result;
}

export function adminRegistrationPayload(payload) {
  const definition = definitionFor("devices");
  return pickFields(payload, definition.registrationFields);
}

export function impactPreviewPayload(payload) {
  const value = pickFields(payload, ["line_ids", "from", "to", "idempotency_key", "policy", "contract"]);
  value.line_ids = Array.isArray(value.line_ids) ? value.line_ids.map((id) => String(id).trim()).filter(Boolean) : [];
  value.policy = pickFields(value.policy || {}, IMPACT_POLICY_FIELDS);
  value.contract = pickFields(value.contract || {}, IMPACT_CONTRACT_FIELDS);
  return value;
}

export function agentUpdatePayload(payload) {
  return pickFields(payload, ["manifest", "device_ids"]);
}

export function createAdminBoundary(api) {
  async function list(resource, query = "") {
    definitionFor(resource);
    const suffix = query ? `?${query}` : "";
    const response = await api.tryRequest(apiAliases(`/admin/${pathFor(resource)}${suffix}`));
    return resource === "schedule" ? [response] : unwrapCollection(response);
  }

  async function create(resource, payload, { id = "" } = {}) {
    const normalized = writableAdminPayload(resource, payload, { id, operation: "create" });
    return api.tryRequest(apiAliases(`/admin/${pathFor(resource)}`), { method: "POST", body: JSON.stringify(normalized) });
  }

  async function update(resource, id, payload) {
    const normalized = writableAdminPayload(resource, payload, { id, operation: "update" });
    return api.tryRequest(apiAliases(`/admin/${pathFor(resource)}/${encodeURIComponent(id)}`), { method: "PUT", body: JSON.stringify(normalized) });
  }

  async function save(resource, id, payload) {
    if (resource === "schedule") {
      const normalized = writableAdminPayload(resource, payload, { operation: "update" });
      return api.tryRequest(apiAliases("/admin/schedules"), { method: "PUT", body: JSON.stringify(normalized) });
    }
    return id ? update(resource, id, payload) : create(resource, payload);
  }

  return {
    list,
    create,
    update,
    save,
    async registerDevice(payload) {
      return api.tryRequest(apiAliases("/admin/devices/register"), { method: "POST", body: JSON.stringify(adminRegistrationPayload(payload)) });
    },
    async deviceAction(id, action, payload) {
      if (!DEVICE_ACTIONS.has(action)) throw contractError("unsupported_device_action", `Unsupported device action: ${action}`);
      const body = payload === undefined ? undefined : JSON.stringify(pickFields(payload, []));
      return api.tryRequest(apiAliases(`/admin/devices/${encodeURIComponent(id)}/${action}`), { method: "POST", body });
    },
    async impactPreview(payload) {
      return api.tryRequest(apiAliases("/admin/impact-preview"), { method: "POST", body: JSON.stringify(impactPreviewPayload(payload)) });
    },
    async agentUpdate(payload) {
      return api.tryRequest(apiAliases("/admin/agent-updates"), { method: "POST", body: JSON.stringify(agentUpdatePayload(payload)) });
    },
    async demoScenario(scenario) {
      return api.tryRequest(apiAliases("/demo/replay"), { method: "POST", body: JSON.stringify({ scenario }) });
    },
    async resetDemo() {
      return api.tryRequest(apiAliases("/admin/demo/reset"), { method: "POST" });
    },
  };
}
