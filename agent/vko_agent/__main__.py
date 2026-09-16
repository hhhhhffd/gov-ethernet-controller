from __future__ import annotations

import argparse
import json

from .agent import DemoProbe, MonitoringAgent, config_from_env


def main() -> None:
    parser = argparse.ArgumentParser(description="VKO LINKWATCH monitoring agent")
    parser.add_argument("--mode", choices=("light", "performance"), default="performance")
    parser.add_argument("--once", action="store_true", help="collect one observation and flush the offline queue")
    parser.add_argument("--server")
    args = parser.parse_args()
    config = config_from_env()
    if args.server:
        config = config.__class__(**{**config.__dict__, "server_url": args.server})
    agent = MonitoringAgent(config, DemoProbe())
    if args.once:
        print(json.dumps(agent.run_once(args.mode), ensure_ascii=False))
    else:
        agent.run_forever()


if __name__ == "__main__":
    main()
