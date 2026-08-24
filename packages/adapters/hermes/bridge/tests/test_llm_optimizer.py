import tempfile
import unittest
from pathlib import Path

from agent_butler_bridge.llm_optimizer import (
    LlmConfig,
    _clean_output,
    should_attempt_llm,
)


class LlmOptimizerTest(unittest.TestCase):
    def test_config_reads_explicit_env_and_disables_without_credentials(self) -> None:
        configured = LlmConfig.from_env(
            {
                "HERMES_BUTLER_LLM_BASE_URL": "https://api.example/v1",
                "HERMES_BUTLER_LLM_API_KEY": "secret",
                "HERMES_BUTLER_LLM_MODEL": "flash",
            },
            config_path=Path("/no/such/config.yaml"),
        )
        self.assertTrue(configured.enabled)
        self.assertEqual(configured.base_url, "https://api.example/v1")
        self.assertEqual(configured.model, "flash")

        disabled = LlmConfig.from_env({}, config_path=Path("/no/such/config.yaml"))
        self.assertFalse(disabled.enabled)

    def test_disabled_flag_wins_over_credentials(self) -> None:
        config = LlmConfig.from_env(
            {
                "HERMES_BUTLER_LLM_BASE_URL": "https://api.example/v1",
                "HERMES_BUTLER_LLM_API_KEY": "secret",
                "HERMES_BUTLER_LLM_MODEL": "flash",
                "HERMES_BUTLER_LLM_ENABLED": "false",
            },
            config_path=Path("/no/such/config.yaml"),
        )
        self.assertFalse(config.enabled)

    def test_short_and_empty_messages_are_skipped(self) -> None:
        config = LlmConfig(
            enabled=True,
            base_url="https://api.example/v1",
            api_key="secret",
            model="flash",
            min_input_chars=8,
        )
        self.assertFalse(should_attempt_llm("在吗", config))
        self.assertFalse(should_attempt_llm("", config))
        self.assertTrue(should_attempt_llm("今天杭州适合跑步吗", config))

    def test_config_discovers_custom_provider(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.yaml"
            config_path.write_text(
                """
model:
  base_url: https://api.deepseek.com/v1
  default: deepseek-v4-flash
  provider: deepseek
custom_providers:
  - name: gpt-5.4
    base_url: https://codeapix.top/v1
    api_key: test-key
    model: gpt-5.4
""".lstrip(),
                encoding="utf-8",
            )
            config = LlmConfig.from_env({}, config_path=config_path)

        self.assertTrue(config.enabled)
        self.assertEqual(config.base_url, "https://codeapix.top/v1")
        self.assertEqual(config.api_key, "test-key")
        self.assertEqual(config.model, "gpt-5.4")

    def test_cleans_fences_and_wrapping_quotes(self) -> None:
        self.assertEqual(
            _clean_output('```text\n"检查今天杭州的天气"\n```'),
            "检查今天杭州的天气",
        )


if __name__ == "__main__":
    unittest.main()
