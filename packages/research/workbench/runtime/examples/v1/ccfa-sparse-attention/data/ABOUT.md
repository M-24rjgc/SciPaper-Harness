# Synthetic data / 合成数据

`pilot.csv` contains authored demonstration values. No benchmark, participant, trained checkpoint or GPU run produced these values. The `seed` field pairs comparable rows within the illustration; it does not identify executed training runs.

`retained_fraction` is the fraction of attention entries retained, from 0 to 1. `accuracy_percent` is an illustrative percentage, from 0 to 100. Each method has three rows. Mean accuracy is 90% for dense attention, 86% for fixed sparse attention and 88% for content-adaptive attention; each sample standard deviation is one percentage point. The matched sparse methods differ by two percentage points in each row.

`pilot.csv` 为编写的合成演示数值，不来自基准测试、受试者、训练权重或 GPU 实验。`seed` 只用于演示行之间的配对，不代表已运行的训练。保留比例为 0 到 1，准确率单位为百分比。三个方法的平均准确率依次为 90%、86%、88%，样本标准差均为 1 个百分点。两个稀疏方法在每个配对行中相差 2 个百分点。
