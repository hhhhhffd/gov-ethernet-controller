import tempfile
import unittest
from pathlib import Path

from vko_agent.agent import DemoProbe, MonitoringAgent, OfflineBuffer, AgentConfig


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


if __name__ == "__main__":
    unittest.main()
