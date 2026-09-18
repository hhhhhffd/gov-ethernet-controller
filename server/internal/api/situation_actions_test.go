package api

import (
	"testing"

	"linkwatch/server/internal/auth"
)

func TestSituationActionIDsAreStableAndUnique(t *testing.T) {
	got, err := uniquePositive([]int64{4, 2, 4, 9})
	if err != nil || len(got) != 3 || got[0] != 4 || got[1] != 2 || got[2] != 9 {
		t.Fatalf("unique IDs = %#v, err=%v", got, err)
	}
	if _, err := uniquePositive([]int64{0}); err == nil {
		t.Fatal("zero ID must be rejected")
	}
}

func TestSituationManagementCapabilityMatchesRoleContract(t *testing.T) {
	if !situationManageAllowed(&auth.Principal{Role: "DISTRICT"}) {
		t.Fatal("district operator should manage scoped situations")
	}
	if !situationManageAllowed(&auth.Principal{Role: "ADMIN"}) {
		t.Fatal("admin should manage situations")
	}
	if situationManageAllowed(&auth.Principal{Role: "PROVIDER"}) {
		t.Fatal("provider must not merge/split situations")
	}
}

func TestSituationSplitRejectsNonMembersAndKeepsOriginalOrder(t *testing.T) {
	left, right, err := partitionSituationMembers([]int64{10, 20, 30}, []int64{30})
	if err != nil || len(left) != 1 || left[0] != 30 || len(right) != 2 || right[0] != 10 || right[1] != 20 {
		t.Fatalf("partition = left %#v right %#v err=%v", left, right, err)
	}
	if _, _, err := partitionSituationMembers([]int64{10, 20}, []int64{99}); err == nil {
		t.Fatal("non-member split selection must fail")
	}
	if _, _, err := partitionSituationMembers([]int64{10, 20}, []int64{10, 20}); err == nil {
		t.Fatal("split leaving no remainder must fail")
	}
}
