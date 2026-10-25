import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('portable_reader', Path(__file__).parents[1] / 'scripts/refresh-youtrack.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

PROFILE = {'host':'friends.youtrack.cloud','login':'jane.doe','project':'TEAM',
           'states':{'backlog':'Open','in-progress':'Doing','done':'Closed'},'syncEnabled':False}

class PortableProfileTests(unittest.TestCase):
    def test_profile_changes_identity_project_query_and_states(self):
        reader.configure(PROFILE)
        seen=[]
        def call(name,args):
            seen.append((name,args))
            if name=='get_current_user': return {'login':'jane.doe'}
            if '#Resolved' in args['query']: return {'issuesPage':[], 'hasNextPage':False}
            return {'issuesPage':[{'id':'TEAM-12','project':'TEAM','summary':'Example','resolvedAt':None,
                'url':'https://friends.youtrack.cloud/issue/TEAM-12',
                'customFields':{'Assignee':'jane.doe','State':'Open','Priority':'Normal'}}], 'hasNextPage':False}
        result=reader.collect(call)
        self.assertEqual(result['assignee'],'jane.doe')
        self.assertEqual(result['issues'][0]['id'],'TEAM-12')
        self.assertIn('TEAM',seen[1][1]['query'])
        self.assertIn('jane.doe',seen[1][1]['query'])
        self.assertEqual(reader.STATES['done'],'Closed')

    def test_no_sync_without_explicit_profile_opt_in(self):
        reader.configure(PROFILE)
        calls=[]
        with self.assertRaises(reader.ReaderError):
            reader.sync_issue_state(lambda *args:calls.append(args),'TEAM-12','Closed')
        self.assertEqual(calls,[])

    def test_credentials_only_arrive_through_bounded_stdin(self):
        payload={'profile':PROFILE,'token':'perm:synthetic-test-token'}
        with patch('sys.stdin',io.StringIO(json.dumps(payload))), patch.object(Path,'read_text',side_effect=AssertionError('No global config reads')):
            self.assertEqual(reader.connection_header(),'Bearer perm:synthetic-test-token')
        self.assertEqual(reader.HOST,'friends.youtrack.cloud')

    def test_rejects_unsafe_hosts_and_query_injection(self):
        for key,value in [('host','https://other.example/path'),('host','x.youtrack.cloud@evil.example'),('host','localhost'),('login','me} #Resolved'),('project','TEAM OR X'),('states',{'done':'Closed'})]:
            with self.subTest(key=key,value=value), self.assertRaises(reader.ReaderError):
                reader.configure({**PROFILE,key:value})

if __name__=='__main__': unittest.main()
