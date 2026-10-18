"""One-shot Home widget helper. Python 3.11+ standard library only.

Receives a device-local profile and token over stdin from Obsidian Keychain. Never writes credentials,
notes, mirrors or configuration. Only --state (or legacy --complete) allows one
column-mapped State write to the named configured-project issue after live preflight checks.
stdout contains only validated data or a
fixed error code; no remote error messages, headers or exception tracebacks.
"""
from datetime import datetime, timezone
import http.client
import json
from pathlib import Path
import re
import sys
import time
import base64
from urllib.parse import urlsplit, quote

HOST = ''
LOGIN = ''
PROJECT = ''
SYNC_ENABLED = False
QUERY = ''
MAX_BYTES = 1024 * 1024
READ_TOOLS = {'get_current_user', 'search_issues', 'get_issue', 'get_issue_comments', 'get_project', 'get_issue_fields_schema'}
STATES = {'backlog': 'To do', 'in-progress': 'In Progress', 'done': 'Done'}
MAX_ATTACHMENT = 20 * 1024 * 1024
MAX_ATTACHMENTS = 50 * 1024 * 1024


class ReaderError(Exception):
    pass


def configure(profile):
    global HOST, LOGIN, PROJECT, STATES, QUERY, SYNC_ENABLED
    if not isinstance(profile, dict):
        raise ReaderError('connection')
    host, login, project = (profile.get(k) for k in ('host', 'login', 'project'))
    if (not isinstance(host, str) or len(host) > 253
            or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+', host)
            or host.rsplit('.', 1)[-1].isdigit()
            or not isinstance(login, str) or not re.fullmatch(r'[A-Za-z0-9_.@+-]{1,100}', login)
            or not isinstance(project, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,30}', project)):
        raise ReaderError('connection')
    states = profile.get('states')
    if (not isinstance(states, dict) or set(states) != {'backlog', 'in-progress', 'done'}
            or any(not isinstance(v, str) or not v.strip() or len(v) > 100 or any(ord(c) < 32 for c in v) for v in states.values())
            or len(set(states.values())) != 3):
        raise ReaderError('state')
    HOST, LOGIN, PROJECT, STATES = host, login, project, dict(states)
    SYNC_ENABLED = profile.get('syncEnabled') is True
    QUERY = f'project: {PROJECT} for: {{{LOGIN}}} #Unresolved sort by: updated desc'


def connection_header():
    """No global credential files, environment secrets, or command-line tokens."""
    try:
        raw = sys.stdin.read(16385)
        if len(raw) > 16384:
            raise ValueError()
        payload = json.loads(raw)
        configure(payload.get('profile'))
        token = payload.get('token')
        if not isinstance(token, str) or not 8 <= len(token) <= 8192 or any(c.isspace() or ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError()
        return 'Bearer ' + token
    except Exception:
        raise ReaderError('connection') from None


def rpc_response(response, request_id):
    """Read bounded JSON or SSE, accepting only this request's response."""
    def unpack(message):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
            raise ReaderError('protocol')
        if message.get('id') != request_id:
            return None
        if 'error' in message or not isinstance(message.get('result'), dict):
            raise ReaderError('protocol')
        return message['result']

    content_type = response.getheader('Content-Type', '').split(';')[0].strip()
    if content_type == 'application/json':
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ReaderError('incomplete')
        result = unpack(json.loads(raw))
        if result is None:
            raise ReaderError('protocol')
        return result
    if content_type != 'text/event-stream':
        raise ReaderError('protocol')
    total, data = 0, []
    while True:
        raw = response.readline(65537)
        total += len(raw)
        if total > MAX_BYTES or len(raw) > 65536:
            raise ReaderError('incomplete')
        if not raw:
            raise ReaderError('incomplete')
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if data:
                result = unpack(json.loads('\n'.join(data)))
                data = []
                if result is not None:
                    return result
        elif line.startswith('data:'):
            data.append(line[5:].removeprefix(' '))


class Client:
    def __init__(self, authorization, state_id=None, target_state=None):
        self.authorization = authorization
        self.session = None
        self.version = None
        self.sequence = 0
        self.deadline = time.monotonic() + 60
        self.state_id = state_id
        self.target_state = target_state
        self.write_attempted = False

    def request(self, method, params, notification=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ReaderError('timeout')
        self.sequence += 1
        message = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if not notification:
            message['id'] = self.sequence
        headers = {'Authorization': self.authorization, 'Content-Type': 'application/json',
                   'Accept': 'application/json, text/event-stream'}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        if self.version:
            headers['MCP-Protocol-Version'] = self.version
        # HTTPSConnection does not follow redirects or environment proxy settings.
        connection = http.client.HTTPSConnection(HOST, timeout=min(15, remaining))
        try:
            connection.request('POST', '/mcp', json.dumps(message).encode(), headers)
            response = connection.getresponse()
            if response.status in (401, 403):
                raise ReaderError('authentication')
            if response.status not in (200, 202):
                raise ReaderError('network')
            if notification:
                return None
            result = rpc_response(response, self.sequence)
            if method == 'initialize':
                session = response.getheader('Mcp-Session-Id')
                if session and (len(session) > 1024 or not re.fullmatch(r'[!-~]+', session)):
                    raise ReaderError('protocol')
                self.session = session
            return result
        finally:
            connection.close()

    def initialize(self):
        result = self.request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
            'clientInfo': {'name': 'es-obsidian-hub', 'version': '0.12.0'}})
        version = result.get('protocolVersion')
        if version not in ('2025-03-26', '2025-06-18', '2025-11-25'):
            raise ReaderError('protocol')
        self.version = version
        self.request('notifications/initialized', {}, notification=True)

    def call(self, name, arguments):
        if name not in READ_TOOLS:
            expected = {'issueId': self.state_id, 'customFields': {'State': self.target_state}}
            if (name != 'update_issue' or not isinstance(self.state_id, str)
                    or not re.fullmatch(rf'{re.escape(PROJECT)}-[0-9]+', self.state_id) or self.target_state not in STATES.values()
                    or arguments != expected or self.write_attempted):
                raise ReaderError('protocol')
            self.write_attempted = True
        result = self.request('tools/call', {'name': name, 'arguments': arguments})
        if result.get('isError'):
            raise ReaderError('remote')
        data = result.get('structuredContent')
        if data is None:
            blocks = result.get('content', [])
            texts = [block.get('text') for block in blocks if block.get('type') == 'text']
            if len(texts) != 1:
                raise ReaderError('protocol')
            data = json.loads(texts[0])
        if not isinstance(data, dict) and not (name == 'get_issue_comments' and isinstance(data, list)):
            raise ReaderError('protocol')
        return data

    def download(self, url):
        path = attachment_path(url)
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ReaderError('timeout')
        connection = http.client.HTTPSConnection(HOST, timeout=min(15, remaining))
        try:
            # The attachment URL is signed by YouTrack. Never forward a bearer token,
            # follow a redirect, fetch another host, or save the signed URL.
            connection.request('GET', path)
            response = connection.getresponse()
            if response.status != 200:
                raise ReaderError('attachment')
            data = response.read(MAX_ATTACHMENT + 1)
            if len(data) > MAX_ATTACHMENT:
                raise ReaderError('attachment_size')
            return data
        finally:
            connection.close()

    def close(self):
        if not self.session:
            return
        connection = http.client.HTTPSConnection(HOST, timeout=3)
        try:
            # End the MCP session only; this is not an issue or account deletion.
            connection.request('DELETE', '/mcp', headers={'Authorization': self.authorization,
                'Mcp-Session-Id': self.session, 'MCP-Protocol-Version': self.version or '2025-06-18'})
            connection.getresponse().close()
        except Exception:
            pass
        finally:
            connection.close()


def collect(call):
    if call('get_current_user', {}).get('login') != LOGIN:
        raise ReaderError('identity')
    issues, seen = [], set()
    for page in range(20):
        data = call('search_issues', {'query': QUERY, 'limit': 20, 'offset': page * 20,
            'customFieldsToReturn': ['State', 'Priority', 'Assignee']})
        rows, more = data.get('issuesPage'), data.get('hasNextPage')
        if not isinstance(rows, list) or type(more) is not bool or len(rows) > 20 or (more and len(rows) != 20):
            raise ReaderError('incomplete')
        for row in rows:
            if not isinstance(row, dict):
                raise ReaderError('incomplete')
            issue_id, fields = row.get('id'), row.get('customFields')
            if not isinstance(issue_id, str) or not re.fullmatch(rf'{re.escape(PROJECT)}-[0-9]+', issue_id) or issue_id in seen:
                raise ReaderError('incomplete')
            if row.get('project') != PROJECT or not isinstance(fields, dict) or fields.get('Assignee') != LOGIN:
                raise ReaderError('incomplete')
            if row.get('url') != f'https://{HOST}/issue/{issue_id}' or row.get('resolvedAt') is not None:
                raise ReaderError('incomplete')
            title, state, priority = row.get('summary'), fields.get('State'), fields.get('Priority')
            if not isinstance(title, str) or not title.strip() or len(title) > 5000 or not isinstance(state, str) or state == STATES['done'] or not isinstance(priority, str):
                raise ReaderError('incomplete')
            seen.add(issue_id)
            issues.append({'id': issue_id, 'title': title, 'assignee': LOGIN, 'state': state,
                'priority': priority, 'url': f'https://{HOST}/issue/{issue_id}'})
        if not more:
            return {'schema': 1, 'source': 'YouTrack MCP', 'assignee': LOGIN,
                'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'issues': issues}
    raise ReaderError('incomplete')


def attachment_path(url):
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or parsed.hostname != HOST or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.fragment or not parsed.path.startswith('/api/files/')
                or any(ord(ch) < 32 for ch in url)):
            raise ValueError()
        return parsed.path + ('?' + parsed.query if parsed.query else '')
    except Exception:
        raise ReaderError('attachment') from None


def collect_detail(call, issue_id, download):
    if not isinstance(issue_id, str) or not re.fullmatch(rf'{re.escape(PROJECT)}-[0-9]+', issue_id):
        raise ReaderError('issue')
    if call('get_current_user', {}).get('login') != LOGIN:
        raise ReaderError('identity')
    detail = call('get_issue', {'issueId': issue_id, 'recentCommentsCount': 0})
    def validate(value):
        if (not isinstance(value, dict) or value.get('id') != issue_id or value.get('project') != PROJECT
                or value.get('url') != f'https://{HOST}/issue/{issue_id}' or value.get('isDraft', False)
                or value.get('customFields', {}).get('Assignee') != LOGIN):
            raise ReaderError('issue')
    validate(detail)
    total = detail.get('totalComments')
    if type(total) is not int or not 0 <= total <= 1000:
        raise ReaderError('incomplete')
    comments, seen = [], set()
    while len(comments) < total:
        page = call('get_issue_comments', {'issueId': issue_id, 'limit': 10, 'offset': len(comments)})
        if not isinstance(page, list) or not 1 <= len(page) <= 10 or len(comments) + len(page) > total:
            raise ReaderError('incomplete')
        for comment in page:
            if (not isinstance(comment, dict) or not isinstance(comment.get('text'), str)
                    or not isinstance(comment.get('url'), str) or comment['url'] in seen):
                raise ReaderError('incomplete')
            address = urlsplit(comment['url'])
            if address.scheme != 'https' or address.hostname != HOST or address.path != f'/issue/{issue_id}':
                raise ReaderError('incomplete')
            seen.add(comment['url']); comments.append(comment)
    latest = call('get_issue', {'issueId': issue_id, 'recentCommentsCount': 0})
    validate(latest)
    if latest.get('updatedAt') != detail.get('updatedAt') or latest.get('totalComments') != total:
        raise ReaderError('changed')
    fields = detail['customFields']
    if (not isinstance(detail.get('summary'), str) or not detail['summary'].strip()
            or not isinstance(fields.get('State'), str) or not isinstance(fields.get('Priority'), str)
            or not isinstance(detail.get('description') or '', str)):
        raise ReaderError('incomplete')
    if len((detail.get('description') or '').encode()) + sum(len(c['text'].encode()) for c in comments) > 4 * 1024 * 1024:
        raise ReaderError('incomplete')
    files, replacements, downloaded = [], {}, 0
    for owner in [detail, *comments]:
        attachments = owner.get('attachments')
        if not isinstance(attachments, list) or len(attachments) > 100:
            raise ReaderError('incomplete')
        owner['localAttachments'] = []
        for item in attachments:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name']:
                raise ReaderError('attachment')
            url = item.get('url'); attachment_path(url)
            if url not in replacements:
                if type(item.get('sizeBytes')) is not int or not 0 <= item['sizeBytes'] <= MAX_ATTACHMENT:
                    raise ReaderError('attachment_size')
                if downloaded + item['sizeBytes'] > MAX_ATTACHMENTS:
                    raise ReaderError('attachment_size')
                data = download(url)
                if len(data) != item['sizeBytes']:
                    raise ReaderError('attachment')
                downloaded += len(data)
                number = len(files) + 1
                name = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|\[\]#^]', '_', item['name']).strip(' .')[:140] or 'attachment'
                files.append({'name': item['name'], 'fileName': f'{number:03d}-{name}', 'size': len(data),
                              'data': base64.b64encode(data).decode('ascii')})
                replacements[url] = f'youtrack-attachment://{number}'
            owner['localAttachments'].append(int(replacements[url].rsplit('/', 1)[1]))
    def body(text):
        text = text or ''
        for owner in [detail, *comments]:
            for item in owner['attachments']:
                token = replacements[item['url']]
                text = text.replace(item['url'], token)
                for name in (item['name'], quote(item['name'])):
                    text = text.replace('](' + name + ')', '](' + token + ')')
                    text = text.replace('](<' + name + '>)', '](' + token + ')')
        return text
    return {'schema': 1, 'source': 'YouTrack MCP', 'id': issue_id, 'assignee': LOGIN,
            'title': detail['summary'], 'description': body(detail.get('description')),
            'url': detail['url'], 'state': fields['State'], 'priority': fields['Priority'],
            'fields': fields, 'tags': detail.get('tags', []), 'updatedAt': detail.get('updatedAt'),
            'fetchedAt': datetime.now(timezone.utc).isoformat(), 'attachments': files,
            'comments': [{'author': c.get('author', ''), 'text': body(c['text']), 'createdAt': c.get('createdAt'),
                          'url': c['url'], 'attachments': c['localAttachments']} for c in comments]}


def sync_issue_state(call, issue_id, target):
    if not SYNC_ENABLED:
        raise ReaderError('state')
    if target not in STATES.values() or not re.fullmatch(rf'{re.escape(PROJECT)}-[0-9]+', issue_id):
        raise ReaderError('state')
    if call('get_current_user', {}).get('login') != LOGIN:
        raise ReaderError('identity')
    project = call('get_project', {'projectKey': PROJECT})
    if project.get('key') != PROJECT or project.get('isArchived') is not False:
        raise ReaderError('issue')
    schema = call('get_issue_fields_schema', {'projectKey': PROJECT})
    state = schema.get('properties', {}).get('State', {})
    if state.get('readOnly', False) or target not in state.get('enum', []):
        raise ReaderError('state')
    def read_state():
        issue = call('get_issue', {'issueId': issue_id, 'recentCommentsCount': 0})
        fields = issue.get('customFields', {})
        if (issue.get('id') != issue_id or issue.get('project') != PROJECT
                or issue.get('url') != f'https://{HOST}/issue/{issue_id}' or issue.get('isDraft', False)
                or fields.get('Assignee') != LOGIN):
            raise ReaderError('issue')
        value = fields.get('State')
        if value not in state['enum']:
            raise ReaderError('state')
        title = issue.get('summary')
        if not isinstance(title, str) or not title.strip() or len(title) > 5000:
            raise ReaderError('incomplete')
        return value, {'id': issue_id, 'title': title, 'state': value, 'assignee': LOGIN,
                       'priority': fields.get('Priority', ''), 'url': issue['url']}
    before, verified = read_state()
    if before != target:
        try:
            call('update_issue', {'issueId': issue_id, 'customFields': {'State': target}})
        except Exception:
            pass  # A timeout can occur after a committed write; reconcile without repeating it.
        try:
            after, verified = read_state()
            if after != target:
                raise ReaderError('uncertain')
        except Exception:
            raise ReaderError('uncertain') from None
    return {'id': issue_id, 'state': target, 'alreadyAtState': before == target, 'issue': verified}


def main(args=None):
    client = None
    try:
        args = [] if args is None else args
        state_change = bool(args and args[0] in ('--state', '--complete'))
        legacy = bool(args and args[0] == '--complete')
        if args:
            if (args[0] not in ('--issue', '--state', '--complete')
                    or len(args) != (3 if args[0] == '--state' else 2)
                    or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,30}-[0-9]+', args[1])):
                raise ReaderError('issue')
            if args[0] == '--state' and args[2] not in STATES:
                raise ReaderError('state')
        authorization = connection_header()
        if args and not re.fullmatch(rf'{re.escape(PROJECT)}-[0-9]+', args[1]):
            raise ReaderError('issue')
        if state_change and not SYNC_ENABLED:
            raise ReaderError('state')
        target = STATES['done'] if legacy else STATES[args[2]] if state_change else None
        client = Client(authorization, state_id=args[1] if state_change else None, target_state=target)
        client.initialize()
        if state_change:
            result = sync_issue_state(client.call, args[1], target)
            if legacy: result['alreadyDone'] = result['alreadyAtState']
            output = {'ok': True, 'completion' if legacy else 'stateChange': result}
        else:
            output = ({'ok': True, 'detail': collect_detail(client.call, args[1], client.download)} if args
                      else {'ok': True, 'snapshot': collect(client.call)})
    except ReaderError as error:
        output = {'ok': False, 'code': str(error)}
    except (TimeoutError, OSError):
        output = {'ok': False, 'code': 'network'}
    except Exception:
        output = {'ok': False, 'code': 'protocol'}
    finally:
        if client:
            client.close()
    print(json.dumps(output, ensure_ascii=False))
    return 0 if output['ok'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
