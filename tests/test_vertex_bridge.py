import importlib.util
import pathlib
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).parents[1] / 'vertex_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AdapterTests(unittest.TestCase):
    def test_schema_system_image_and_cap(self):
        model, payload = bridge.build_request({
            'model': 'gemini-3.6-flash-minimal', 'max_tokens': 9000,
            'messages': [{'role': 'system', 'content': 'Translate'}, {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,aGVsbG8='}},
                {'type': 'text', 'text': 'Page'},
            ]}],
            'response_format': {'type': 'json_schema', 'json_schema': {'schema': {'type': 'object', 'properties': {'label': {'type': 'string'}}, 'additionalProperties': False}}},
        })
        self.assertEqual(model, 'gemini-3.6-flash')
        self.assertEqual(payload['systemInstruction']['parts'], [{'text': 'Translate'}])
        self.assertIn('inlineData', payload['contents'][0]['parts'][0])
        cfg = payload['generationConfig']
        self.assertEqual(cfg['maxOutputTokens'], 4096)
        self.assertEqual(cfg['thinkingConfig']['thinkingLevel'], 'MINIMAL')
        self.assertEqual(cfg['responseSchema']['propertyOrdering'], ['label'])
        self.assertNotIn('additionalProperties', cfg['responseSchema'])

    def test_argon_alias_uses_low_thinking(self):
        model, payload = bridge.build_request({'model': 'gemini-4-argon-low', 'messages': [{'role': 'user', 'content': 'Hi'}]})
        self.assertEqual(model, 'gemini-4-argon')
        self.assertEqual(payload['generationConfig']['thinkingConfig']['thinkingLevel'], 'LOW')

    def test_reject_remote_image_and_unknown_model(self):
        with self.assertRaises(ValueError):
            bridge.build_request({'model': 'unapproved'})
        with self.assertRaises(ValueError):
            bridge.build_request({'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'http://example.com/image.png'}}]}]})

    def test_usage_includes_billed_thinking(self):
        usage = bridge.usage_openai({'promptTokenCount': 10, 'candidatesTokenCount': 5, 'thoughtsTokenCount': 20})
        self.assertEqual(usage['completion_tokens'], 25)
        self.assertEqual(usage['total_tokens'], 35)

    def test_media_resolution_override(self):
        msg = [{'role': 'user', 'content': 'Hi'}]
        self.assertEqual(bridge.build_request({'messages': msg})[1]['generationConfig']['mediaResolution'], 'MEDIA_RESOLUTION_HIGH')
        self.assertEqual(bridge.build_request({'messages': msg, 'media_resolution': 'low'})[1]['generationConfig']['mediaResolution'], 'MEDIA_RESOLUTION_LOW')
        with self.assertRaises(ValueError):
            bridge.build_request({'messages': msg, 'media_resolution': 'ultra'})

    def test_token_and_hosts(self):
        self.assertTrue(bridge.token_ok(None, None))
        self.assertTrue(bridge.token_ok('Bearer s3cret-token-0123456789', 's3cret-token-0123456789'))
        self.assertTrue(bridge.token_ok('bearer s3cret-token-0123456789', 's3cret-token-0123456789'))
        self.assertFalse(bridge.token_ok(None, 's3cret-token-0123456789'))
        self.assertFalse(bridge.token_ok('Bearer wrong', 's3cret-token-0123456789'))
        self.assertFalse(bridge.token_ok('s3cret-token-0123456789', 's3cret-token-0123456789'))
        self.assertTrue(bridge.host_permitted('127.0.0.1:8001', 8001, set()))
        self.assertFalse(bridge.host_permitted('nixos.example.ts.net:8443', 8001, set()))
        self.assertTrue(bridge.host_permitted('nixos.example.ts.net:8443', 8001, {'nixos.example.ts.net:8443'}))

    def test_policy_blocks_are_named(self):
        self.assertEqual(bridge.incomplete_message('PROHIBITED_CONTENT', None), 'Blocked by Google content policy (PROHIBITED_CONTENT).')
        self.assertEqual(bridge.incomplete_message(None, 'SAFETY'), 'Blocked by Google content policy (SAFETY).')
        self.assertEqual(bridge.incomplete_message(None, None), 'Vertex returned no complete answer (None).')


if __name__ == '__main__':
    unittest.main()
