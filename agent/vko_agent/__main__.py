from __future__ import annotations

import argparse
import json
from dataclasses import replace

from .agent import MonitoringAgent, build_probe, config_from_env


def main() -> None:
    parser = argparse.ArgumentParser(description="VKO LINKWATCH monitoring agent")
    parser.add_argument("--mode", choices=("light", "performance"), default="performance")
    parser.add_argument("--once", action="store_true", help="collect one observation and flush the offline queue")
    parser.add_argument("--server")
    parser.add_argument("--probe", choices=("demo", "network"), help="override the configured telemetry probe")
    args = parser.parse_args()
    config = config_from_env()
    if args.server:
        config = replace(config, server_url=args.server)
    if args.probe:
        config = replace(config, probe_type=args.probe)
    agent = MonitoringAgent(config, build_probe(config))
    if args.once:
        print(json.dumps(agent.run_once(args.mode), ensure_ascii=False))
    else:
        agent.run_forever()


if __name__ == "__main__":
    main()
