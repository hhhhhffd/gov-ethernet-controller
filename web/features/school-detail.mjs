function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function linesFromContext(context) {
  return Array.isArray(context?.lines) ? context.lines.filter((line) => text(line?.id)) : [];
}

export function createSelectedSchool(context, selectedLineId = null) {
  const lines = linesFromContext(context);
  const selected = selectedLineId && lines.some((line) => line.id === selectedLineId)
    ? selectedLineId
    : lines.length === 1
      ? lines[0].id
      : null;
  return {
    context,
    school: context?.school ?? lines[0]?.registrySchool ?? null,
    lines,
    selectedLineId: selected,
    registryOnly: context?.kind === "registry" || lines.length === 0,
    detail: null,
    detailState: "idle",
  };
}

export function selectSchoolLine(selection, lineId) {
  if (!selection?.lines?.some((line) => line.id === lineId)) return selection;
  return { ...selection, selectedLineId: lineId, detail: null, detailState: "idle" };
}

export function selectedLine(selection) {
  return selection?.lines?.find((line) => line.id === selection.selectedLineId) ?? null;
}

export function mergeLineDetail(line, payload) {
  if (!line || !payload || typeof payload !== "object") return line;
  const detail = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const latest = { ...(line.latest || {}), ...(detail.latest || {}) };
  return {
    ...line,
    ...detail,
    registrySchool: line.registrySchool,
    registryId: line.registryId,
    linkwatchStatus: detail.status || detail.connection_state || detail.state?.connection_state || line.linkwatchStatus,
    latest,
  };
}

export function availableMetrics(line) {
  const latest = line?.latest || {};
  return [
    ["download", latest.download],
    ["upload", latest.upload],
    ["ping", latest.ping],
    ["jitter", latest.jitter],
    ["loss", latest.loss ?? latest.packet_loss],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
}

export function activeIncident(line) {
  const incidents = Array.isArray(line?.incidents) ? line.incidents : [];
  return incidents.find((incident) => !["CLOSED", "RESOLVED"].includes(String(incident?.status || "").toUpperCase())) ?? null;
}
