package api

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

const trustedProxyCIDRsEnv = "LINKWATCH_TRUSTED_PROXY_CIDRS"

// ValidateRuntimeConfig rejects a production setup that would otherwise accept
// forwarding metadata without an explicit reverse-proxy trust boundary.
func ValidateRuntimeConfig() error {
	_, err := trustedProxyNetworksFromEnv()
	return err
}

func trustedProxyNetworksFromEnv() ([]*net.IPNet, error) {
	networks, err := parseTrustedProxyCIDRs(os.Getenv(trustedProxyCIDRsEnv))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", trustedProxyCIDRsEnv, err)
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("LINKWATCH_ENV")), "production") && len(networks) == 0 {
		return nil, fmt.Errorf("%s must contain at least one proxy address or CIDR in production", trustedProxyCIDRsEnv)
	}
	return networks, nil
}

func parseTrustedProxyCIDRs(value string) ([]*net.IPNet, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parts := strings.Split(value, ",")
	networks := make([]*net.IPNet, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, fmt.Errorf("empty proxy entry")
		}
		if ip := net.ParseIP(part); ip != nil {
			bits := 128
			if ipv4 := ip.To4(); ipv4 != nil {
				ip = ipv4
				bits = 32
			}
			networks = append(networks, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		_, network, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy address %q", part)
		}
		networks = append(networks, network)
	}
	return networks, nil
}

func (s *Server) authClientKey(r *http.Request) string {
	return authClientKeyWithTrustedProxies(r, s.trustedProxyCIDRs)
}

// authClientKey is kept as a small compatibility helper for package-local
// callers and tests. A running Server uses the startup-validated config above.
func authClientKey(r *http.Request) string {
	networks, err := trustedProxyNetworksFromEnv()
	if err != nil {
		// Invalid configuration is rejected before a production server starts.
		// Falling back to the immediate peer here keeps this helper fail-closed.
		networks = nil
	}
	return authClientKeyWithTrustedProxies(r, networks)
}

func authClientKeyWithTrustedProxies(r *http.Request, trustedProxyCIDRs []*net.IPNet) string {
	peer := immediatePeerKey(r)
	if !isTrustedProxy(peer, trustedProxyCIDRs) {
		return peer
	}
	if client := firstForwardedIP(r.Header.Values("X-Forwarded-For")); client != "" {
		return client
	}
	return peer
}

func immediatePeerKey(r *http.Request) string {
	peer := normalizePeerIP(r.RemoteAddr)
	if peer == "" {
		return "unknown"
	}
	return peer
}

func isTrustedProxy(peer string, networks []*net.IPNet) bool {
	ip := net.ParseIP(peer)
	if ip == nil {
		return false
	}
	for _, network := range networks {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func firstForwardedIP(values []string) string {
	for _, value := range values {
		for _, candidate := range strings.Split(value, ",") {
			if ip := normalizePeerIP(candidate); ip != "" {
				return ip
			}
		}
	}
	return ""
}

func normalizePeerIP(address string) string {
	address = strings.TrimSpace(address)
	if address == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	} else if strings.HasPrefix(address, "[") && strings.HasSuffix(address, "]") {
		address = strings.TrimSuffix(strings.TrimPrefix(address, "["), "]")
	}
	ip := net.ParseIP(address)
	if ip == nil {
		return ""
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return ipv4.String()
	}
	return ip.String()
}
