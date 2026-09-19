import { apiAliases, unwrapCollection } from "../core/api.mjs";

const RESOURCE_PATHS = Object.freeze({ districts: "catalogs/districts", technologies: "catalogs/technologies", schedule: "schedules" });
const pathFor = (resource) => RESOURCE_PATHS[resource] || resource;

export function createAdminBoundary(api) {
  return {
    async list(resource, query = "") { const suffix = query ? `?${query}` : ""; const response = await api.tryRequest(apiAliases(`/admin/${pathFor(resource)}${suffix}`)); return resource === "schedule" ? [response] : unwrapCollection(response); },
    async create(resource, payload) { return api.tryRequest(apiAliases(`/admin/${pathFor(resource)}`), { method: "POST", body: JSON.stringify(payload) }); },
    async update(resource, id, payload) { return api.tryRequest(apiAliases(`/admin/${pathFor(resource)}/${encodeURIComponent(id)}`), { method: "PUT", body: JSON.stringify(payload) }); },
    async registerDevice(payload) { return api.tryRequest(apiAliases("/admin/devices/register"), { method: "POST", body: JSON.stringify(payload) }); },
    async deviceAction(id, action, payload) { return api.tryRequest(apiAliases(`/admin/devices/${encodeURIComponent(id)}/${action}`), { method: "POST", body: payload ? JSON.stringify(payload) : undefined }); },
    async impactPreview(payload) { return api.tryRequest(apiAliases("/admin/impact-preview"), { method: "POST", body: JSON.stringify(payload) }); },
    async agentUpdate(payload) { return api.tryRequest(apiAliases("/admin/agent-updates"), { method: "POST", body: JSON.stringify(payload) }); },
  };
}
