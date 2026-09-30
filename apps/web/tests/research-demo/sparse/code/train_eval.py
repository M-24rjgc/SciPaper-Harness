"""示例项目的实验脚本（替身）。

真实项目里，这里是块稀疏注意力的训练与评测代码。为了让示例项目在任何机器上
几秒钟就能复现，本脚本不训练模型，而是输出预先给定的示例数值（EXAMPLE_RESULTS），
并像真实脚本一样把指标写进 $RESEARCH_METRICS_PATH。这些数值不是测量结果。
"""
import argparse
import json
import os
import time
from pathlib import Path

EXAMPLE_RESULTS = {
    ('full', 42): {'accuracy': 0.821, 'perplexity': 6.18, 'relative_flops': 1.0, 'peak_memory_gb': 61.5},
    ('fixed', 42): {'accuracy': 0.811, 'perplexity': 6.29, 'relative_flops': 0.25, 'peak_memory_gb': 37.9},
    ('dynamic', 42): {'accuracy': 0.814, 'perplexity': 6.32, 'relative_flops': 0.26, 'peak_memory_gb': 38.2},
    ('dynamic', 97): {'accuracy': 0.806, 'perplexity': 6.41, 'relative_flops': 0.26, 'peak_memory_gb': 38.4},
    ('dynamic', 13): {'accuracy': 0.809, 'perplexity': 6.36, 'relative_flops': 0.26, 'peak_memory_gb': 38.3},
}


def main():
    parser = argparse.ArgumentParser(description='Block-sparse attention evaluation on RULER (example stand-in).')
    parser.add_argument('--variant', choices=['full', 'fixed', 'dynamic'], required=True)
    parser.add_argument('--context', type=int, default=32768)
    parser.add_argument('--seed', type=int, required=True)
    args = parser.parse_args()
    print(f'variant={args.variant} context={args.context} seed={args.seed}', flush=True)
    for step in range(200, 1401, 200):
        time.sleep(0.15)
        print(f'step {step}/1400', flush=True)
    metrics = EXAMPLE_RESULTS[(args.variant, args.seed)]
    target = Path(os.environ.get('RESEARCH_METRICS_PATH', 'metrics.json'))
    target.write_text(json.dumps(metrics), encoding='utf-8')
    print('run-complete', json.dumps(metrics), flush=True)


if __name__ == '__main__':
    main()
