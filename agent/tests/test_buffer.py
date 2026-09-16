import tempfile
import unittest
import os
from unittest.mock import patch
from pathlib import Path

from vko_agent.agent import AgentConfig, DemoProbe, MonitoringAgent, NetworkProbe, OfflineBuffer, build_probe, config_from_env


class BufferTests(unittest.TestCase):
    def test_duplicate_event_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            buffer = OfflineBuffer(Path(directory) / "queue.sqlite3")
            event_id = buffer.enqueue({"value": 1}, "stable-event")
            self.assertEqual(buffer.enqueue({"value": 2}, "stable-event"), event_id)
            self.assertEqual(buffer.pending_count(), 1)
            self.assertEqual(buffer.pending()[0][2]["value"], 1)
            buffer.close()

    def test_demo_agent_keeps_event_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = MonitoringAgent(AgentConfig(buffer_path=Path(directory) / "queue.sqlite3"), DemoProbe())
            result = agent.run_once()
            self.assertEqual(result["sent"], 0)
            self.assertEqual(result["pending"], 1)
            self.assertEqual(agent.buffer.pending()[0][2]["line_id"], "line-42-primary")
            agent.buffer.close()

    def test_schedule_has_three_to_five_tests_and_one_day_span(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = MonitoringAgent(AgentConfig(buffer_path=Path(directory) / "queue.sqlite3", tests_per_day=5, jitter_minutes=30), DemoProbe())
            delays = agent.schedule_delays()
            self.assertEqual(len(delays), 5)
            self.assertTrue(all(delay >= 60 for delay in delays))
            self.assertEqual(sum(delays), 24 * 60 * 60)
            agent.buffer.close()

    def test_network_probe_reports_bounded_metrics_without_external_calls(self):
        probe = NetworkProbe(targets=("https://probe.example/health",), ping_host="probe.example", ping_count=3, throughput_url=None)
        with patch.object(probe, "_http_reachability", return_value=(True, 12.5, None)), patch.object(probe, "_ping_samples", return_value=([10.0, 12.0, 11.0], 0, [], "tcp")):
            result = probe.measure("light")
        self.assertEqual(result["connection_status"], "OK")
        self.assertEqual(result["mode"], "LIGHT")
        self.assertEqual(result["packet_loss"], 0)
        self.assertGreater(result["ping"], 0)
        self.assertIn("reachability", result["raw"])

    def test_production_config_selects_real_probe(self):
        with patch.dict(os.environ, {"VKO_ENV": "production"}, clear=True):
            config = config_from_env()
        self.assertEqual(config.probe_type, "network")
        with tempfile.TemporaryDirectory() as directory:
            buffer = OfflineBuffer(Path(directory) / "queue.sqlite3")
            agent = MonitoringAgent(config, buffer=buffer)
            self.assertIsInstance(agent.probe, NetworkProbe)
            buffer.close()

    def test_unknown_probe_type_fails_closed(self):
        with self.assertRaises(ValueError):
            build_probe(AgentConfig(probe_type="typo"))
        with patch.dict(os.environ, {"VKO_ENV": "production"}, clear=True):
            with self.assertRaises(ValueError):
                build_probe(AgentConfig(probe_type="demo"))

    def test_production_agent_requires_https_server(self):
        with patch.dict(os.environ, {"VKO_ENV": "production"}, clear=True), tempfile.TemporaryDirectory() as directory:
            buffer = OfflineBuffer(Path(directory) / "queue.sqlite3")
            agent = MonitoringAgent(AgentConfig(buffer_path=buffer.path, server_url="http://127.0.0.1:8000"), DemoProbe(), buffer)
            agent.collect("light")
            with self.assertRaises(ValueError):
                agent.flush()
            buffer.close()


if __name__ == "__main__":
    unittest.main()
