"""The board's machine probe, run as the board runs it and piece by piece against stand-in system files."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PROBE = Path(__file__).resolve().parents[1] / 'runtime' / 'board_probe.py'
spec = importlib.util.spec_from_file_location('board_probe', PROBE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='科研 probe ')
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_reports_this_machine_and_the_named_runs_progress(self):
        run = self.root / 'run'
        run.mkdir()
        lines = [json.dumps({'epoch': epoch, 'acc': epoch / 10, 'note': 'x', 'flag': True}) for epoch in range(1, 11)]
        (run / 'progress.jsonl').write_text('\n'.join(lines + ['[1]', 'not json', '{"epoch": 11']), encoding='utf8')
        request = json.dumps({'disk': str(self.root / 'missing' / 'deeper'), 'progress': [str(run), str(self.root / 'none')], 'limit': 4})
        # Run as the board runs it: the script on standard input, the request as its one argument.
        output = subprocess.run([sys.executable, '-', request], input=PROBE.read_text(encoding='utf8'), capture_output=True, text=True, encoding='utf8', check=True)
        report = json.loads(output.stdout)
        self.assertEqual(set(report), {'host', 'os', 'gpus', 'cpu', 'memory', 'disk', 'progress'})
        self.assertEqual(report['disk']['path'], str(self.root))
        self.assertEqual([row['epoch'] for row in report['progress'][str(run)]], [1, 3, 6, 10])
        self.assertEqual(report['progress'][str(run)][0], {'epoch': 1, 'acc': 0.1})
        self.assertEqual(report['progress'][str(self.root / 'none')], [])
        self.assertIsInstance(report['cpu']['cores'], int)

    def test_reads_nvidia_smi_and_passes_over_what_it_cannot_parse(self):
        answer = mock.Mock(returncode=0, stdout='A100, 50, 2048, 40960, 61, [N/A], 300\nshort, row\n')
        with mock.patch.object(probe.subprocess, 'run', return_value=answer):
            self.assertEqual(probe.gpus(), [{'name': 'A100', 'util': 50.0, 'memoryUsed': 2048.0, 'memoryTotal': 40960.0, 'temperature': 61.0, 'power': None, 'powerLimit': 300.0}])
        with mock.patch.object(probe.subprocess, 'run', return_value=mock.Mock(returncode=9, stdout='')):
            self.assertEqual(probe.gpus(), [])
        with mock.patch.object(probe.subprocess, 'run', side_effect=OSError('no nvidia-smi')):
            self.assertEqual(probe.gpus(), [])
        self.assertIsNone(probe.number('inf'))

    def test_uses_a_cgroup_quota_and_limit_when_a_container_has_them(self):
        files = {'/sys/fs/cgroup/cpu.max': '200000 100000', '/sys/fs/cgroup/memory.max': '1000', '/sys/fs/cgroup/memory.current': '250'}
        usage = iter(['usage_usec 1000000', 'usage_usec 1250000'])

        def read(path):
            if path == '/sys/fs/cgroup/cpu.stat':
                return next(usage)
            return files.get(path)
        with mock.patch.object(probe, 'read', side_effect=read), mock.patch.object(probe.os, 'name', 'posix'), \
                mock.patch.object(probe.time, 'monotonic', side_effect=[0, 0.25]), mock.patch.object(probe.time, 'sleep'):
            self.assertEqual(probe.cpu(), {'util': 0.5, 'cores': 2.0})
            self.assertEqual(probe.memory(), {'used': 250.0, 'total': 1000.0})
        for text in (None, 'max 100000', '5'):
            with mock.patch.object(probe, 'read', return_value=text):
                self.assertIsNone(probe.cgroup_quota())

    def test_reads_proc_stat_and_meminfo_without_a_container(self):
        stats = iter(['cpu  100 0 100 800 0\n', 'cpu  150 0 150 900 0\n'])
        meminfo = 'MemTotal: 1000 kB\nMemAvailable: 400 kB\nEmpty:\n'

        def read(path):
            return next(stats) if path == '/proc/stat' else meminfo if path == '/proc/meminfo' else None
        with mock.patch.object(probe, 'read', side_effect=read), mock.patch.object(probe.os, 'name', 'posix'), mock.patch.object(probe.time, 'sleep'):
            self.assertEqual(probe.cpu()['util'], 0.5)
            self.assertEqual(probe.memory(), {'used': 600 * 1024, 'total': 1000 * 1024})
        with mock.patch.object(probe, 'read', return_value='intr 1'), mock.patch.object(probe.os, 'name', 'posix'), mock.patch.object(probe.time, 'sleep'):
            self.assertEqual(set(probe.cpu()), {'cores'})
            self.assertIsNone(probe.memory())

    def test_thins_to_the_limit_keeping_the_last_row(self):
        self.assertEqual(probe.thin([1, 2], 5), [1, 2])
        self.assertEqual(probe.thin(list(range(10)), 4), [0, 2, 5, 9])

    @unittest.skipUnless(os.name == 'nt', 'Windows system calls')
    def test_reads_windows_processor_and_memory_counters(self):
        self.assertEqual(len(probe.windows_times()), 2)
        memory = probe.memory()
        self.assertGreater(memory['total'], memory['used'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
