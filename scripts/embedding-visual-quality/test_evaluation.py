import unittest
from common import metrics

class MetricsTest(unittest.TestCase):
    def test_perfect(self):
        m=metrics(['a','b'],{'a','b'},[1,2])
        self.assertEqual(m['Recall@1'],.5)
        self.assertEqual(m['Recall@2'],1)
        self.assertEqual(m['nDCG@2'],1)
        self.assertEqual(m['MRR'],1)
    def test_second_rank(self):
        m=metrics(['x','a'],{'a'},[1,2])
        self.assertEqual(m['MRR'],.5)
        self.assertEqual(m['MRR@1'],0)
        self.assertAlmostEqual(m['nDCG@2'],0.6309297535714575)
    def test_missing(self):
        m=metrics(['x'],{'a'},[1,5])
        self.assertTrue(all(v==0 for v in m.values()))
    def test_invalid(self):
        for ranking,labels in [(['a','a'],{'a'}),([],set())]:
            with self.assertRaises(ValueError): metrics(ranking,labels,[1])
if __name__=='__main__':unittest.main()

class ZipSafetyTest(unittest.TestCase):
    def build(self,name,symlink=False):
        import io,zipfile
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as z:
            info=zipfile.ZipInfo(name)
            if symlink:info.external_attr=0o120777<<16
            z.writestr(info,b'x')
        return data.getvalue()
    def test_reject_paths(self):
        from evaluate import archive
        for name in ['../x','/x','folder\\x']:
            with self.assertRaises(ValueError):archive(self.build(name))
    def test_reject_symlink(self):
        from evaluate import archive
        with self.assertRaises(ValueError):archive(self.build('x',True))
    def test_safe_member(self):
        from evaluate import archive
        with archive(self.build('folder/x')) as z:self.assertEqual(z.read('folder/x'),b'x')
