"""Rendered Actions source resolver; synthetic environment and mocked API only."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = (Path(__file__).parents[1]/'resolve-release.py').read_text()
for key, value in {'@@FORGEJO_API_URL@@': 'https://forgejo.test/api/v1',
                   '@@FORGEJO_OWNER@@': 'owner', '@@REPOSITORY@@': 'project'}.items():
    source = source.replace(key, value)
resolver = type(os)('rendered_resolver')
exec(compile(source, 'resolve-release.py', 'exec'), resolver.__dict__)


class ResolverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.env = {'HOME': str(self.home), 'SOURCE_BRANCH': 'feature/demo', 'SOURCE_SHA': '',
                    'CONTROL_REF': 'refs/heads/main', 'CONTROL_SHA': 'c'*40, 'CI_RUN_ID': '123',
                    'FORGEJO_RELEASE_TOKEN': 'synthetic-secret', 'RELEASE_CONTEXT': str(self.home/'context.json'),
                    'GITHUB_OUTPUT': str(self.home/'output')}
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, self.env, clear=True).start()
        self.head = 'a'*40
        self.requests = patch.object(resolver, 'request', side_effect=self.response).start()

    def response(self, path, token):
        self.assertEqual(token, 'synthetic-secret')
        if '/branches/' in path:
            return {'commit': {'id': self.head}}
        return {'commit': {'committer': {'date': '2026-11-09T23:00:00-05:00'}}}

    def test_empty_sha_resolves_execution_time_head_once_with_utc_date(self):
        self.head = 'b'*40  # A queued request resolves only now, not at button click.
        context = resolver.resolve()
        self.assertEqual(context['source_sha'], 'b'*40)
        self.assertEqual(context['version'], '20261110-bbbbbbbb')
        self.assertEqual(context['release_inputs'], {'source_branch': 'feature/demo', 'source_sha': ''})
        self.assertEqual(self.requests.call_count, 2)
        self.assertIn('/branches/feature%2Fdemo', self.requests.call_args_list[0].args[0])
        self.assertEqual(str(resolver.uuid.UUID(context['release_request_id'])), context['release_request_id'])
        self.head = 'd'*40
        self.assertEqual(context['source_branch_head'], 'b'*40)

    def test_explicit_sha_is_fixed_independently_of_current_head(self):
        os.environ['SOURCE_SHA'] = 'd'*40
        context = resolver.resolve()
        self.assertEqual(context['source_sha'], 'd'*40)
        self.assertEqual(context['source_branch_head'], 'a'*40)
        self.assertTrue(self.requests.call_args.args[0].endswith('/git/commits/'+'d'*40))

    def test_bad_input_or_ci_identity_stops_before_api(self):
        for key, value in [('SOURCE_BRANCH', '-bad'), ('SOURCE_BRANCH', 'main bad'), ('SOURCE_SHA', 'HEAD'),
                           ('SOURCE_SHA', 'a'*39), ('CONTROL_REF', 'refs/heads/dev'), ('CI_RUN_ID', '0')]:
            with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}):
                self.requests.reset_mock()
                with self.assertRaises(ValueError):
                    resolver.resolve()
                self.requests.assert_not_called()

    def test_missing_secret_never_falls_back_to_home(self):
        token = self.home/'.config/forgejo/token'
        token.parent.mkdir(parents=True)
        token.write_text('must-not-read')
        with patch.dict(os.environ, {'FORGEJO_RELEASE_TOKEN': ''}), patch.object(resolver.Path, 'read_text') as read:
            with self.assertRaisesRegex(ValueError, 'RELEASE_TOKEN'):
                resolver.resolve()
            self.requests.assert_not_called()
            read.assert_not_called()

    def test_outputs_contain_frozen_identity_not_tokens(self):
        import contextlib
        import io
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            resolver.main()
        context = json.loads((self.home/'context.json').read_text())
        self.assertEqual(context['source_sha'], 'a'*40)
        self.assertIn('source_sha='+'a'*40, (self.home/'output').read_text())
        self.assertNotIn('synthetic-secret', output.getvalue())

    def test_missing_branch_lookup_propagates_without_dispatch(self):
        self.requests.side_effect = ValueError('Forgejo source lookup failed: HTTP 404')
        with self.assertRaisesRegex(ValueError, 'HTTP 404'):
            resolver.resolve()
        self.assertEqual(self.requests.call_count, 1)
