import unittest

from p1_09_cost_model import calculate_usage, summarize_usage


JOB = "b274db39-cfd5-46bf-8438-27557b89201a"


def sample(**changes):
    event = {
        "jobId": JOB,
        "requestId": "ci_request_000001",
        "provider": "fixture",
        "model": "ci-model-v1",
        "inputTokens": 1000,
        "outputTokens": 500,
        "inputMicroUsdPerMillion": 2_000_000,
        "outputMicroUsdPerMillion": 8_000_000,
    }
    event.update(changes)
    return event


class CostModelTests(unittest.TestCase):
    def test_integer_cost_is_explicitly_estimated(self):
        receipt = calculate_usage(sample())
        self.assertEqual(receipt["estimatedCostMicroUsd"], 6000)
        self.assertEqual(receipt["inputTokens"], 1000)
        self.assertTrue(receipt["estimated"])

    def test_rounding_and_zero_usage(self):
        tiny = sample(inputTokens=1, outputTokens=0,
                      inputMicroUsdPerMillion=1, outputMicroUsdPerMillion=0)
        self.assertEqual(calculate_usage(tiny)["estimatedCostMicroUsd"], 1)
        zero = sample(inputTokens=0, outputTokens=0)
        self.assertEqual(calculate_usage(zero)["estimatedCostMicroUsd"], 0)

    def test_duplicate_retry_is_not_double_charged(self):
        report = summarize_usage([sample(), sample()])
        self.assertEqual(len(report), 1)
        self.assertEqual(report[0]["requests"], 1)
        self.assertEqual(report[0]["estimatedCostMicroUsd"], 6000)

    def test_conflicting_duplicate_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
            summarize_usage([sample(), sample(outputTokens=100)])

    def test_multiple_jobs_are_separate(self):
        other = "a2a748e1-845c-472e-91be-7edb782ab2dc"
        report = summarize_usage([sample(), sample(jobId=other)])
        self.assertEqual([row["jobId"] for row in report], [other, JOB])
        self.assertEqual(sum(row["requests"] for row in report), 2)

    def test_no_freeform_fields_or_floating_point(self):
        invalid = [
            sample(apiKey="not permitted"),
            sample(inputTokens=-1),
            sample(inputTokens=True),
            sample(outputTokens=0.5),
            sample(inputMicroUsdPerMillion=-1),
            sample(provider="http://host"),
            sample(requestId="short"),
            sample(jobId="unsafe"),
            sample(model="secret model"),
        ]
        for record in invalid:
            with self.subTest(record=record):
                with self.assertRaises(ValueError):
                    calculate_usage(record)

    def test_invalid_batches_are_rejected(self):
        with self.assertRaises(ValueError):
            summarize_usage([sample() for _ in range(101)])
        with self.assertRaises(ValueError):
            summarize_usage({"events": [sample()]})


if __name__ == "__main__":
    unittest.main()
