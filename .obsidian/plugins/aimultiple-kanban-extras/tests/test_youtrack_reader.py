"""No live credentials/network: fake MCP responses and temporary configuration."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reader', Path(__file__).parents[1] / 'scripts/refresh-youtrack.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def issue(number):
    return {'id': f'DEMO-{number}', 'url': f'https://{reader.HOST}/issue/DEMO-{number}', 'project': 'DEMO',
        'summary': f'Card {number}', 'resolvedAt': None,
        'customFields': {'Assignee': 'Alex', 'State': 'To do', 'Priority': 'Normal'}}


class Response(io.BytesIO):
    status = 200

    def __init__(self, body, content_type='application/json', session=None):
        super().__init__(body)
        self.headers = {'Content-Type': content_type, 'Mcp-Session-Id': session}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)


PROFILE = {'host':'tracker.example.com','login':'Alex','project':'DEMO','states':{'backlog':'To do','in-progress':'In Progress','done':'Done'},'syncEnabled':True}

class ReaderTests(unittest.TestCase):
    def setUp(self):
        reader.configure(PROFILE)

    def completion_call(self, *, owner='Alex', state='In Progress', readonly=False, fail_write=False, readback='Done'):
        calls = []
        def call(name, args):
            calls.append((name, args))
            if name == 'get_current_user': return {'login': 'Alex'}
            if name == 'get_project': return {'key': 'DEMO', 'isArchived': False}
            if name == 'get_issue_fields_schema': return {'properties': {'State': {'enum': ['To do', 'In Progress', 'Done', 'Parked'], 'readOnly': readonly}}}
            if name == 'update_issue':
                if fail_write: raise OSError('PRIVATE_ERROR')
                return {'id': 'DEMO-900'}
            if name == 'get_issue':
                row = issue(900)
                row['customFields'].update(Assignee=owner, State=readback if any(n == 'update_issue' for n, _ in calls) else state)
                return row
            raise AssertionError(name)
        return call, calls

    def test_completion_checks_owner_schema_and_reads_back_only_state_write(self):
        # Run the CLI behavior through a fake Client; no real connection or issue is touched.
        call, calls = self.completion_call()
        fake = type('Fake', (), {'initialize': lambda s: None, 'close': lambda s: None, 'call': staticmethod(call)})()
        with patch.object(reader, 'connection_header', return_value='fake'), patch.object(reader, 'Client', return_value=fake), patch('sys.stdout', new_callable=io.StringIO) as out:
            code = reader.main(['--complete', 'DEMO-900'])
        self.assertEqual(code, 0, out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['completion']['state'], 'Done')
        writes = [(n, a) for n, a in calls if n == 'update_issue']
        self.assertEqual(writes, [('update_issue', {'issueId': 'DEMO-900', 'customFields': {'State': 'Done'}})])
        self.assertEqual(calls[-1][0], 'get_issue')

    def test_state_cli_maps_each_column_and_reopens_resolved_done(self):
        for column, target in [('backlog', 'To do'), ('in-progress', 'In Progress'), ('done', 'Done')]:
            call, calls = self.completion_call(state='Done' if column != 'done' else 'To do', readback=target)
            def resolved_call(name, args):
                result = call(name, args)
                if name == 'get_issue' and result['customFields']['State'] == 'Done': result['resolvedAt'] = '2026-10-17'
                return result
            fake = type('Fake', (), {'initialize': lambda s: None, 'close': lambda s: None, 'call': staticmethod(resolved_call)})()
            with patch.object(reader, 'connection_header', return_value='fake'), patch.object(reader, 'Client', return_value=fake), patch('sys.stdout', new_callable=io.StringIO) as out:
                code = reader.main(['--state', 'DEMO-900', column])
            self.assertEqual(code, 0, out.getvalue())
            self.assertEqual(json.loads(out.getvalue())['stateChange']['state'], target)
            self.assertEqual([(n,a) for n,a in calls if n == 'update_issue'], [('update_issue', {'issueId':'DEMO-900','customFields':{'State':target}})])
            self.assertEqual(calls[-1][0], 'get_issue')

    def test_completion_rejects_foreign_owner_or_readonly_state_without_writing(self):
        for options in ({'owner': 'Other'}, {'readonly': True}):
            call, calls = self.completion_call(**options)
            # The CLI must expose a completion mode before its validation can be tested.
            fake = type('Fake', (), {'initialize': lambda s: None, 'close': lambda s: None, 'call': staticmethod(call)})()
            with patch.object(reader, 'connection_header', return_value='fake'), patch.object(reader, 'Client', return_value=fake), patch('sys.stdout', new_callable=io.StringIO) as out:
                reader.main(['--complete', 'DEMO-900'])
            self.assertTrue(calls, 'Completion must reach the read-only preflight')
            self.assertFalse(json.loads(out.getvalue())['ok'])
            self.assertNotIn('update_issue', [n for n, _ in calls])

    def test_completion_reconciles_timeout_and_never_repeats_write(self):
        for options, ok in [({'state': 'Done'}, True), ({'fail_write': True}, True), ({'fail_write': True, 'readback': 'In Progress'}, False)]:
            call, calls = self.completion_call(**options)
            fake = type('Fake', (), {'initialize': lambda s: None, 'close': lambda s: None, 'call': staticmethod(call)})()
            with patch.object(reader, 'connection_header', return_value='fake'), patch.object(reader, 'Client', return_value=fake), patch('sys.stdout', new_callable=io.StringIO) as out:
                reader.main(['--complete', 'DEMO-900'])
            result = json.loads(out.getvalue())
            self.assertEqual(result['ok'], ok)
            self.assertLessEqual([n for n, _ in calls].count('update_issue'), 1)
            if not ok: self.assertEqual(result['code'], 'uncertain')

    def test_identity_and_read_allowlist(self):
        calls = []
        def call(name, args):
            calls.append(name)
            return {'login': 'Other'}
        with self.assertRaisesRegex(reader.ReaderError, 'identity'):
            reader.collect(call)
        self.assertEqual(calls, ['get_current_user'])
        with self.assertRaisesRegex(reader.ReaderError, 'protocol'):
            reader.Client('Bearer FAKE').call('update_issue', {})

    def test_state_cli_rejects_unknown_targets_before_connection_and_skips_matching_state(self):
        for args in (['--state', 'DEMO-900', 'Parked'], ['--state', 'DEMO-900'], ['--state', '../AIM-1', 'done']):
            with patch.object(reader, 'connection_header') as connection, patch('sys.stdout', new_callable=io.StringIO):
                self.assertEqual(reader.main(args), 1)
            connection.assert_not_called()
        for target in ('To do', 'In Progress', 'Done'):
            call, calls = self.completion_call(state=target)
            result = reader.sync_issue_state(call, 'DEMO-900', target)
            self.assertEqual(result['state'], target)
            self.assertNotIn('update_issue', [n for n, _ in calls])

    def test_state_writer_pins_one_target_and_rejects_other_fields_or_repeat_writes(self):
        for target in ('To do', 'In Progress', 'Done'):
            client = reader.Client('Bearer FAKE', state_id='DEMO-900', target_state=target)
            requests = []
            client.request = lambda method, params: requests.append(params) or {'content': [{'type':'text','text':'{}'}]}
            for args in ({'issueId':'DEMO-901','customFields':{'State':target}},
                         {'issueId':'DEMO-900','customFields':{'State':'Parked'}},
                         {'issueId':'DEMO-900','customFields':{'State':target,'Priority':'Urgent'}}):
                with self.assertRaises(reader.ReaderError): client.call('update_issue', args)
            allowed = {'issueId':'DEMO-900','customFields':{'State':target}}
            client.call('update_issue', allowed)
            with self.assertRaises(reader.ReaderError): client.call('update_issue', allowed)
            self.assertEqual(len(requests), 1)

    def test_writer_allows_only_one_done_update_for_the_named_issue(self):
        client = reader.Client('Bearer FAKE', state_id='DEMO-900', target_state='Done')
        requests = []
        client.request = lambda method, params: requests.append(params) or {'content': [{'type': 'text', 'text': '{}'}]}
        for args in ({'issueId': 'DEMO-901', 'customFields': {'State': 'Done'}},
                     {'issueId': 'DEMO-900', 'customFields': {'State': 'In Progress'}},
                     {'issueId': 'DEMO-900', 'customFields': {'State': 'Done'}, 'description': 'wrong'}):
            with self.assertRaisesRegex(reader.ReaderError, 'protocol'):
                client.call('update_issue', args)
        allowed = {'issueId': 'DEMO-900', 'customFields': {'State': 'Done'}}
        client.call('update_issue', allowed)
        with self.assertRaisesRegex(reader.ReaderError, 'protocol'):
            client.call('update_issue', allowed)
        self.assertEqual(len(requests), 1)

    def test_collects_all_pages_and_only_returns_widget_fields(self):
        requests = []
        def call(name, args):
            requests.append((name, args))
            if name == 'get_current_user':
                return {'login': 'Alex'}
            offset = args['offset']
            return {'issuesPage': [issue(i) for i in range(offset + 1, min(offset + 21, 22))], 'hasNextPage': offset == 0}
        snapshot = reader.collect(call)
        self.assertEqual(len(snapshot['issues']), 21)
        self.assertEqual([args['offset'] for name, args in requests if name == 'search_issues'], [0, 20])
        self.assertEqual(set(snapshot['issues'][0]), {'id', 'title', 'assignee', 'state', 'priority', 'url'})
        self.assertEqual(snapshot['source'], 'YouTrack MCP')

    def test_rejects_partial_duplicate_foreign_or_resolved_rows(self):
        cases = [
            {'issuesPage': [issue(1)], 'hasNextPage': True},
            {'issuesPage': [issue(1), issue(1)], 'hasNextPage': False},
            {'issuesPage': [{**issue(1), 'url': 'https://other.invalid/'}], 'hasNextPage': False},
            {'issuesPage': [{**issue(1), 'resolvedAt': '2026-10-16'}], 'hasNextPage': False},
            {'issuesPage': [{**issue(1), 'customFields': {'Assignee': 'Other'}}], 'hasNextPage': False},
            {'issuesPage': [], 'hasNextPage': 'false'},
        ]
        for result in cases:
            with self.subTest(result=result), self.assertRaisesRegex(reader.ReaderError, 'incomplete'):
                reader.collect(lambda name, args: {'login': 'Alex'} if name == 'get_current_user' else result)

    def test_json_and_sse_responses_match_request_and_are_bounded(self):
        result = {'jsonrpc': '2.0', 'id': 7, 'result': {'value': 'ok'}}
        self.assertEqual(reader.rpc_response(Response(json.dumps(result).encode()), 7), {'value': 'ok'})
        stream = b': heartbeat\n\ndata: {"jsonrpc":"2.0","method":"notice"}\n\n'
        stream += b'data: ' + json.dumps(result).encode() + b'\n\n'
        self.assertEqual(reader.rpc_response(Response(stream, 'text/event-stream'), 7), {'value': 'ok'})
        with self.assertRaises(reader.ReaderError):
            reader.rpc_response(Response(json.dumps(result).encode()), 8)
        with self.assertRaisesRegex(reader.ReaderError, 'incomplete'):
            reader.rpc_response(Response(b'x' * (reader.MAX_BYTES + 1)), 7)
        with self.assertRaisesRegex(reader.ReaderError, 'protocol'):
            reader.rpc_response(Response(b'{"jsonrpc":"2.0","id":7,"error":{"message":"SECRET"}}'), 7)

    def test_stdin_uses_profile_and_does_not_read_configuration(self):
        payload = json.dumps({'profile':PROFILE,'token':'perm:FAKE'})
        with patch('sys.stdin', io.StringIO(payload)), patch.object(Path,'read_text',side_effect=AssertionError('no config reads')):
            self.assertEqual(reader.connection_header(), 'Bearer perm:FAKE')
        for token in ('bad\nvalue','short','Bearer value'):
            with patch('sys.stdin',io.StringIO(json.dumps({'profile':PROFILE,'token':token}))):
                with self.assertRaises(reader.ReaderError): reader.connection_header()

    def test_transport_uses_fixed_destination_session_and_negotiated_version(self):
        sent = []
        class Connection:
            def __init__(self, host, **kwargs):
                self.host = host
            def request(self, method, path, body=None, headers=None):
                sent.append((self.host, method, path, json.loads(body) if body else None, headers))
            def getresponse(self):
                message = sent[-1][3]
                if message['method'] == 'initialize':
                    return Response(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {'protocolVersion': '2025-06-18'}}).encode(), session='test-session')
                if message['method'] == 'notifications/initialized':
                    response = Response(b'');response.status = 202;return response
                return Response(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {'content': [{'type': 'text', 'text': '{"login":"Alex"}'}]}}).encode())
            def close(self):
                pass
        with patch.object(reader.http.client, 'HTTPSConnection', Connection):
            client = reader.Client('Bearer FAKE');client.initialize()
            self.assertEqual(client.call('get_current_user', {}), {'login': 'Alex'})
        self.assertTrue(all(row[:3] == (reader.HOST, 'POST', '/mcp') for row in sent))
        self.assertEqual(sent[-1][4]['Mcp-Session-Id'], 'test-session')
        self.assertEqual(sent[-1][4]['MCP-Protocol-Version'], '2025-06-18')

    def test_cli_redacts_unexpected_errors(self):
        output = io.StringIO()
        with patch.object(reader, 'connection_header', side_effect=Exception('TOKEN_SECRET')), patch('sys.stdout', output):
            self.assertEqual(reader.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'code': 'protocol'})


class DetailTests(unittest.TestCase):
    def setUp(self):
        reader.configure(PROFILE)

    def detail(self, **changes):
        return {**issue(9), 'description': 'Full **Markdown**\n- [ ] Step', 'updatedAt': '2026-10-17 00:00:00',
                'totalComments': 0, 'attachments': [], 'tags': [], **changes}

    def test_detail_collects_all_comments_and_downloads_attachments_before_returning(self):
        self.assertTrue(callable(getattr(reader, 'collect_detail', None)), 'Selected issue detail reader is required')
        comments = [{'url': f'https://{reader.HOST}/issue/DEMO-9#comment-{n}', 'author': 'Alex',
                     'text': f'Comment {n}', 'createdAt': n, 'attachments': []} for n in range(11)]
        attachment = {'name': 'photo.png', 'url': f'https://{reader.HOST}/api/files/1?sign=fixture', 'sizeBytes': 3, 'mimeType': 'image/png'}
        detail = self.detail(totalComments=11, attachments=[attachment]); calls=[]
        def call(name, args):
            calls.append((name,args))
            if name == 'get_current_user': return {'login': 'Alex'}
            if name == 'get_issue': return detail
            if name == 'get_issue_comments': return comments[args['offset']:args['offset']+args['limit']]
            raise AssertionError(name)
        result=reader.collect_detail(call, 'DEMO-9', lambda url: b'abc')
        self.assertEqual(result['description'], detail['description'])
        self.assertEqual(len(result['comments']),11)
        self.assertEqual(result['attachments'][0]['data'],'YWJj')
        self.assertNotIn('sign=fixture',json.dumps(result))
        self.assertEqual([args['offset'] for name,args in calls if name=='get_issue_comments'],[0,10])

    def test_detail_rejects_wrong_owner_truncated_comments_changed_issue_and_failed_download(self):
        self.assertTrue(callable(getattr(reader, 'collect_detail', None)), 'Selected issue detail reader is required')
        for kind in ['owner','comments','changed','attachment']:
            count=0
            detail=self.detail()
            if kind=='owner': detail['customFields']['Assignee']='Other'
            if kind=='comments': detail['totalComments']=1
            if kind=='attachment': detail['attachments']=[{'name':'a.png','url':f'https://{reader.HOST}/api/files/1','sizeBytes':3}]
            def call(name,args):
                nonlocal count
                if name=='get_current_user':return {'login':'Alex'}
                if name=='get_issue_comments':return []
                count+=1
                return {**detail,'updatedAt':'changed'} if kind=='changed' and count>1 else detail
            def download(url): raise reader.ReaderError('attachment')
            with self.subTest(kind=kind),self.assertRaises(reader.ReaderError):
                reader.collect_detail(call,'DEMO-9',download)

    def test_detail_only_accepts_res_ids_and_fixed_attachment_host(self):
        self.assertTrue(callable(getattr(reader, 'collect_detail', None)), 'Selected issue detail reader is required')
        for value in ['DEMO-9/../x','../config','OTHER-1','DEMO-9\n']:
            with self.assertRaises(reader.ReaderError):reader.collect_detail(lambda *args: self.fail('No remote call expected'),value,lambda _:b'')
        for url in ['https://other.invalid/a','http://'+reader.HOST+'/api/files/1','https://user:pass@'+reader.HOST+'/api/files/1']:
            with self.assertRaises(reader.ReaderError):reader.attachment_path(url)


if __name__ == '__main__':
    unittest.main()
