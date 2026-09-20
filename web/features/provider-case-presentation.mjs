function code(value, fallback = "UNKNOWN") {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[.\s-]+/g, "_");
  return normalized || fallback;
}

function latestVerifiedAt(evidenceChain) {
  const verified = (Array.isArray(evidenceChain) ? evidenceChain : [])
    .map((item) => item?.verification?.verified_at)
    .filter((value) => value && !Number.isNaN(new Date(value).getTime()))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime());
  return verified[0] || null;
}

function provenance(evidenceChain) {
  return (Array.isArray(evidenceChain) ? evidenceChain : []).some((item) => item?.configuration_provenance?.historical)
    ? "HISTORICAL_EVIDENCE"
    : "UNKNOWN";
}

const PENDING_ACTIONS = Object.freeze(new Set(["creating", "saving", "generating", "sending", "retrying"]));

export function providerCaseActions(providerCase, capabilities, actionState = "idle") {
  const status = code(providerCase?.status);
  const deliveryStatus = code(providerCase?.delivery_status);
  const incidentStatus = code(providerCase?.incident?.status);
  const parentClosed = incidentStatus === "CLOSED";
  const canDeliver = capabilities?.has?.("provider_case.send") === true;
  const canDraft = capabilities?.has?.("provider_case.draft") === true;
  const retryableFailure = deliveryStatus === "FAILED" && providerCase?.delivery_retryable === true;
  const isPending = PENDING_ACTIONS.has(actionState);
  const canRetry = canDeliver && retryableFailure && !isPending;
  const canInitialSend = canDeliver && !parentClosed && status !== "SENT" && deliveryStatus === "PENDING" && !isPending;
  return {
    canPrepare: canDraft && !parentClosed && !isPending,
    canEdit: canDraft && !parentClosed && status !== "SENT" && !isPending,
    canGenerate: canDraft && !parentClosed && status !== "SENT" && !isPending,
    canInitialSend,
    canRetry: canRetry && !parentClosed,
    canSend: canInitialSend || canRetry,
    isRetry: retryableFailure,
    parentClosed,
    operation: retryableFailure ? "retry" : "send",
    isPending,
    disabled: isPending,
    pendingState: actionState,
  };
}

export function providerCaseDeliveryRequest(providerCase, { finalText = "", incidentId, reviewed = true } = {}) {
  const retry = code(providerCase?.delivery_status) === "FAILED" && providerCase?.delivery_retryable === true;
  const payload = { reviewed: reviewed === true };
  if (finalText) payload.final_text = String(finalText).trim();
  if (incidentId !== undefined && incidentId !== null && incidentId !== "") payload.incident_id = incidentId;
  return { operation: retry ? "retry" : "send", payload };
}

export function presentProviderCase(providerCase, { i18n, presentation }) {
  const status = code(providerCase?.status);
  const deliveryStatus = code(providerCase?.delivery_status);
  const source = code(providerCase?.source_context);
  const provenanceCode = provenance(providerCase?.evidence_chain);
  const verifiedAt = latestVerifiedAt(providerCase?.evidence_chain);
  const text = typeof providerCase?.final_text === "string" && providerCase.final_text.trim()
    ? providerCase.final_text
    : providerCase?.draft_text || "";
  return {
    id: providerCase?.id,
    reference: providerCase?.ticket_no || providerCase?.external_ticket_no || String(providerCase?.id ?? ""),
    status,
    statusLabel: i18n.t(`providerCase.status.${status}`, undefined, i18n.t("providerCase.status.UNKNOWN")),
    deliveryStatus,
    deliveryLabel: presentation.deliveryStatus(deliveryStatus),
    sourceLabel: i18n.t(`providerCase.source.${source}`, undefined, i18n.t("providerCase.source.UNKNOWN")),
    createdAtLabel: presentation.formatDate(providerCase?.created_at, true),
    sentAtLabel: presentation.formatDate(providerCase?.sent_at, true),
    lastVerifiedLabel: verifiedAt ? presentation.formatDate(verifiedAt, true) : i18n.t("providerCase.unavailableValue"),
    provenanceLabel: i18n.t(`providerCase.provenance.${provenanceCode}`, undefined, i18n.t("providerCase.provenance.UNKNOWN")),
    text,
    deliveryError: typeof providerCase?.delivery_error === "string" ? providerCase.delivery_error.trim() : "",
    deliveryAttempts: Number(providerCase?.delivery_attempts) || 0,
    nextAttemptLabel: presentation.formatDate(providerCase?.next_attempt_at, true),
    externalReference: providerCase?.external_ticket_no || "",
  };
}
