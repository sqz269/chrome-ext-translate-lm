"""Loopback OpenAI-compatible streaming adapter for Vertex. No third-party packages."""
import argparse
import base64
import json
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {
    'gemini-3.6-flash-minimal': ('gemini-3.6-flash', 'MINIMAL'),
    'gemini-3.8-flash-low': ('gemini-3.8-flash', 'LOW'),
    'gemini-4-argon-low': ('gemini-4-argon', 'LOW'),  # Argon has no MINIMAL level.
}
MAX_BODY = 20 * 1024 * 1024


class Credentials:
    def __init__(self):
        self.token = None
        self.expires = 0
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            if self.token and time.monotonic() < self.expires:
                return self.token
            executable = shutil.which('gcloud.cmd') or shutil.which('gcloud')
            if not executable:
                raise RuntimeError('gcloud is missing. Install Google Cloud CLI and run gcloud auth application-default login.')
            proc = subprocess.run(
                [executable, 'auth', 'application-default', 'print-access-token'],
                capture_output=True, text=True, timeout=40,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if proc.returncode or not proc.stdout.strip():
                raise RuntimeError('Google ADC authentication failed. Run gcloud auth application-default login.')
            self.token = proc.stdout.strip()
            self.expires = time.monotonic() + 3000
            return self.token


def vertex_schema(schema):
    """Translate the supported subset of the extension's JSON schemas."""
    allowed = {'type', 'properties', 'items', 'required', 'minItems', 'maxItems', 'description', 'enum'}
    result = {k: v for k, v in schema.items() if k in allowed}
    if 'type' in result:
        result['type'] = result['type'].upper()
    if 'properties' in result:
        result['properties'] = {k: vertex_schema(v) for k, v in result['properties'].items()}
        result['propertyOrdering'] = list(result['properties'])
    if 'items' in result:
        result['items'] = vertex_schema(result['items'])
    return result


def build_request(body):
    alias = body.get('model', 'gemini-3.6-flash-minimal')
    if alias not in MODELS:
        raise ValueError('Unknown model. Use one of the bridge /v1/models entries.')
    model, thinking = MODELS[alias]
    contents, system = [], []
    for message in body.get('messages', []):
        role = message.get('role')
        if role not in ('system', 'user', 'assistant'):
            raise ValueError('Unsupported message role.')
        content = message.get('content', '')
        parts = []
        for item in ([{'type': 'text', 'text': content}] if isinstance(content, str) else content):
            if item.get('type') == 'text':
                parts.append({'text': item['text']})
            elif item.get('type') == 'image_url':
                url = item.get('image_url', {}).get('url', '')
                match = re.fullmatch(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)', url)
                if not match:
                    raise ValueError('Images must be inline PNG, JPEG or WebP data URLs.')
                base64.b64decode(match[2], validate=True)
                parts.append({'inlineData': {'mimeType': match[1], 'data': match[2]}})
            else:
                raise ValueError('Unsupported message content.')
        if role == 'system':
            if any('inlineData' in p for p in parts):
                raise ValueError('System instructions must be text.')
            system.extend(parts)
        else:
            contents.append({'role': 'model' if role == 'assistant' else 'user', 'parts': parts})
    if not contents:
        raise ValueError('At least one user message is required.')
    resolution = body.get('media_resolution', 'high')  # image token budget: low 260, medium 532, high 1080 (3.6 Flash)
    if resolution not in ('low', 'medium', 'high'):
        raise ValueError('media_resolution must be low, medium or high.')
    config = {
        'temperature': body.get('temperature', 0.2),
        'maxOutputTokens': min(4096, max(1, int(body.get('max_tokens', 4096)))),
        'thinkingConfig': {'thinkingLevel': thinking},
        'mediaResolution': 'MEDIA_RESOLUTION_' + resolution.upper(),
    }
    response_format = body.get('response_format', {})
    if response_format.get('type') == 'json_schema':
        config['responseMimeType'] = 'application/json'
        config['responseSchema'] = vertex_schema(response_format['json_schema']['schema'])
    result = {'contents': contents, 'generationConfig': config}
    if system:
        result['systemInstruction'] = {'parts': system}
    return model, result


POLICY_FINISH = {'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'}


def incomplete_message(block_reason, finish_reason):
    # Vertex reports input blocks in promptFeedback.blockReason and output blocks as the finish reason.
    reason = block_reason or (finish_reason if finish_reason in POLICY_FINISH else None)
    if reason:
        return f'Blocked by Google content policy ({reason}).'
    return f'Vertex returned no complete answer ({finish_reason}).'


def usage_openai(usage):
    prompt = usage.get('promptTokenCount', 0)
    thinking = usage.get('thoughtsTokenCount', 0)
    completion = usage.get('candidatesTokenCount', 0) + thinking
    return {
        'prompt_tokens': prompt, 'completion_tokens': completion,
        'total_tokens': prompt + completion,
        'prompt_tokens_details': {'cached_tokens': usage.get('cachedContentTokenCount', 0)},
        'completion_tokens_details': {'reasoning_tokens': thinking},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log user content, request headers, or credentials.

    def permitted(self):
        origin = self.headers.get('Origin', '')
        host = self.headers.get('Host', '')
        return host in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}') and (
            not origin or re.fullmatch(r'chrome-extension://[a-p]{32}', origin) is not None)

    def headers_for(self, status, mime):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if self.headers.get('Origin') and self.permitted():
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Connection', 'close')
        self.close_connection = True

    def reply(self, status, value):
        self.headers_for(status, 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())

    def do_OPTIONS(self):
        if not self.permitted():
            return self.reply(403, {'error': 'Origin or host not allowed.'})
        self.headers_for(204, 'text/plain')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if not self.permitted():
            return self.reply(403, {'error': 'Origin or host not allowed.'})
        if self.path == '/health':
            return self.reply(200, {'service': 'lm-translate-vertex', 'project': self.server.project, 'location': self.server.location})
        if self.path == '/v1/models':
            return self.reply(200, {'object': 'list', 'data': [{'id': m, 'object': 'model'} for m in MODELS]})
        self.reply(404, {'error': 'Route not found.'})

    def do_POST(self):
        if not self.permitted():
            return self.reply(403, {'error': 'Origin or host not allowed.'})
        if self.path != '/v1/chat/completions':
            return self.reply(404, {'error': 'Route not found.'})
        if self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'Use application/json.'})
        started = False
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': 'Request must be between 1 byte and 20 MiB.'})
            body = json.loads(self.rfile.read(length))
            if body.get('stream') is not True:
                raise ValueError('This bridge requires stream:true.')
            model, payload = build_request(body)
            token = self.server.credentials.get()
            url = f'https://aiplatform.googleapis.com/v1/projects/{self.server.project}/locations/{self.server.location}/publishers/google/models/{model}:streamGenerateContent?alt=sse'
            request = urllib.request.Request(url, json.dumps(payload).encode(), {
                'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            })
            with urllib.request.urlopen(request, timeout=90) as upstream:
                self.headers_for(200, 'text/event-stream')
                self.end_headers()
                started = True
                def send(value):
                    self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                    self.wfile.flush()
                usage, finish, blocked = {}, None, None
                for raw in upstream:
                    if not raw.startswith(b'data:'):
                        continue
                    event = json.loads(raw[5:])
                    if event.get('error'):
                        raise RuntimeError('Vertex stream returned an error.')
                    usage = event.get('usageMetadata', usage)
                    blocked = event.get('promptFeedback', {}).get('blockReason', blocked)
                    for candidate in event.get('candidates', []):
                        finish = candidate.get('finishReason', finish)
                        for part in candidate.get('content', {}).get('parts', []):
                            if part.get('text') and not part.get('thought'):
                                send({'model': model, 'choices': [{'index': 0, 'delta': {'content': part['text']}, 'finish_reason': None}]})
                if finish not in ('STOP', 'MAX_TOKENS'):
                    raise RuntimeError(incomplete_message(blocked, finish))
                send({'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'length' if finish == 'MAX_TOKENS' else 'stop'}], 'usage': usage_openai(usage)})
                self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError):
                # Provider errors contain diagnostics, never include our auth headers.
                detail = error.read().decode(errors='replace')[:1000]
                message = f'Vertex HTTP {error.code}: {detail}'
            else:
                message = str(error)
            try:
                if started:
                    self.wfile.write(('data: ' + json.dumps({'error': {'message': message}}) + '\n\n').encode())
                else:
                    self.reply(400 if isinstance(error, (ValueError, KeyError, TypeError)) else 502, {'error': {'message': message}})
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', default='buoyant-program-477612-e3')
    parser.add_argument('--location', default='us')
    parser.add_argument('--port', type=int, default=8001)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9-]+', args.project) or args.location not in ('us', 'eu', 'global'):
        parser.error('Use a valid project ID and us/eu/global location.')
    ThreadingHTTPServer.request_queue_size = 64  # the default backlog of 5 refuses parallel page requests
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.project, server.location = args.project, args.location
    server.credentials = Credentials()
    print(f'Vertex bridge on 127.0.0.1:{args.port}; project={args.project}; location={args.location}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
