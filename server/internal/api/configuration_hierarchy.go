package api

// configurationHierarchy describes the existing canonical precedence. It is a
// projection, not a second configuration store.
func configurationHierarchy(policy, contract, context map[string]interface{}, historical bool) map[string]interface{} {
	result := map[string]interface{}{
		"precedence":   []string{"LINE_POLICY", "GLOBAL_POLICY", "LINE_CONTRACT", "LINE_CONTEXT_VERSION"},
		"policy":       map[string]interface{}{"selected": len(policy) > 0, "scope_type": stringValueOrUnknown(policy, "scope_type"), "scope_id": valueOrUnknown(policy, "scope_id")},
		"contract":     map[string]interface{}{"selected": len(contract) > 0, "scope_type": "LINE", "scope_id": valueOrUnknown(contract, "line_id")},
		"line_context": map[string]interface{}{"selected": len(context) > 0, "scope_type": "LINE", "version": valueOrUnknown(context, "version")},
		"historical":   historical,
	}
	if len(policy) == 0 {
		result["policy_reason"] = "no stored policy snapshot; resolution is unknown"
	}
	if len(contract) == 0 {
		result["contract_reason"] = "no stored line contract snapshot; resolution is unknown"
	}
	if len(context) == 0 {
		result["context_reason"] = "no stored line context version; migration/history context is unknown"
	}
	return result
}

func stringValueOrUnknown(value map[string]interface{}, key string) string {
	if result, ok := value[key].(string); ok && result != "" {
		return result
	}
	return "UNKNOWN"
}

func valueOrUnknown(value map[string]interface{}, key string) interface{} {
	if result, ok := value[key]; ok && result != nil {
		return result
	}
	return "UNKNOWN"
}
