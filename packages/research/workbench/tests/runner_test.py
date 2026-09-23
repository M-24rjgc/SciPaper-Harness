"""Run real detached child processes; no GPU, network or user experiments are used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'runtime' / 'experiment_runner.py'


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='科研 runner space ')
        self.root = Path(self.temporary.name)

    def tearDown(self):
        if (self.root / 'state.json').exists():
            self.call('cancel')
            self.wait()
        self.temporary.cleanup()

    def setup_script(self, content, budget=10):
        script = self.root / 'script.py'
        script.write_text(content, encoding='utf8')
        (self.root / 'spec.json').write_text(json.dumps(dict(argv=['{python}', str(script)], python=sys.executable, cwd=str(self.root), gpuIds=[], seed=42, maxSeconds=budget, metricsPath='metrics.json')), encoding='utf8')

    def call(self, action):
        return json.loads(subprocess.check_output([sys.executable, str(RUNNER), action, str(self.root)], text=True, encoding='utf8'))

    def wait(self):
        for _ in range(80):
            state = self.call('status')
            if state['status'] not in ('queued', 'running'):
                return state
            time.sleep(.15)
        self.fail('Supervisor did not settle')

    def test_detached_survival_and_duplicate_submission(self):
        self.setup_script("import time,os,json,pathlib\np=pathlib.Path('launches');p.write_text(p.read_text()+'x' if p.exists() else 'x')\ntime.sleep(1)\nassert os.environ['CUDA_VISIBLE_DEVICES']==''\npathlib.Path(os.environ['RESEARCH_METRICS_PATH']).write_text(json.dumps({'accuracy':.75}))\n")
        first = self.call('launch')
        second = self.call('launch')
        self.assertEqual(first['runnerPid'], second['runnerPid'])
        result = self.wait()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['metrics']['accuracy'], .75)
        self.assertEqual((self.root / 'launches').read_text(), 'x')

    def test_cancel_owned_process(self):
        self.setup_script('import time\ntime.sleep(90)')
        self.call('launch'); self.call('cancel')
        self.assertEqual(self.wait()['status'], 'cancelled')

    def test_run_time_limit(self):
        self.setup_script('import time\ntime.sleep(90)', budget=1)
        self.call('launch')
        self.assertIn('maxSeconds', self.wait()['message'])

    def test_cwd_outputs_are_collected(self):
        self.setup_script("import os,pathlib\n"
                          "pathlib.Path('outputs/plots').mkdir(parents=True)\npathlib.Path('outputs/plots/curve.csv').write_text('x,y')\n"
                          "pathlib.Path(os.environ['RESEARCH_OUTPUT_DIR'], 'direct.txt').write_text('ok')\n")
        work = self.root / 'work'
        work.mkdir()
        spec = json.loads((self.root / 'spec.json').read_text(encoding='utf8'))
        (self.root / 'spec.json').write_text(json.dumps(dict(spec, cwd=str(work))), encoding='utf8')
        self.call('launch')
        self.assertEqual(self.wait()['status'], 'completed')
        self.assertEqual((self.root / 'outputs' / 'plots' / 'curve.csv').read_text(), 'x,y')
        self.assertEqual((self.root / 'outputs' / 'direct.txt').read_text(), 'ok')

    def test_restart_identity_and_stale_queue(self):
        (self.root / 'state.json').write_text(json.dumps(dict(status='running', runnerPid=99999999, runnerIdentity='other-boot', updatedAt=time.time())))
        self.assertEqual(self.call('status')['status'], 'interrupted')
        (self.root / 'state.json').write_text(json.dumps(dict(status='queued', updatedAt=time.time()-60)))
        self.assertEqual(self.call('status')['status'], 'interrupted')

    def test_non_finite_metrics_cannot_become_successful_evidence(self):
        self.setup_script("import pathlib,os\npathlib.Path(os.environ['RESEARCH_METRICS_PATH']).write_text('{\"loss\": NaN}')")
        self.call('launch')
        self.assertEqual(self.wait()['status'], 'failed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
