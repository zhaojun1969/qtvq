#!/usr/bin/env bash
# 30 秒片合成：frames + music + 四段 VO → CBR 10M / 1080×1920 / 30fps / -14 LUFS
# 用法：bash compose.sh
set -euo pipefail
cd "$(dirname "$0")"

FF=/d/ATVA/tools/video/node_modules/ffmpeg-static/ffmpeg.exe
[ -x "$FF" ] || FF=ffmpeg

# VO 出点（秒），与分镜时码对齐
AD1=6000; AD2=12200; AD3=21400; AD4=26700

echo "[1/4] 混音：音乐床 + 四段配音"
"$FF" -y -hide_banner -loglevel error \
  -i music.wav -i vo/vo1.mp3 -i vo/vo2.mp3 -i vo/vo3.mp3 -i vo/vo4.mp3 \
  -filter_complex "\
    [0:a]volume=0.62[mus];\
    [1:a]loudnorm=I=-16:TP=-1.5:LRA=7,adelay=${AD1}|${AD1}[v1];\
    [2:a]loudnorm=I=-16:TP=-1.5:LRA=7,adelay=${AD2}|${AD2}[v2];\
    [3:a]loudnorm=I=-16:TP=-1.5:LRA=7,adelay=${AD3}|${AD3}[v3];\
    [4:a]loudnorm=I=-16:TP=-1.5:LRA=7,adelay=${AD4}|${AD4}[v4];\
    [mus][v1][v2][v3][v4]amix=inputs=5:normalize=0:duration=longest:dropout_transition=0[mix]" \
  -map "[mix]" -ac 2 -ar 44100 -c:a pcm_s16le mix_raw.wav

echo "[2/4] 测响度（LUFS / 真峰值）"
JSON=$("$FF" -hide_banner -nostats -i mix_raw.wav -af loudnorm=I=-14:TP=-1:LRA=9:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
INPUT_I=$(echo "$JSON" | python -c "import sys,json;print(json.load(sys.stdin)['input_i'])")
INPUT_TP=$(echo "$JSON" | python -c "import sys,json;print(json.load(sys.stdin)['input_tp'])")
echo "  原始：I=${INPUT_I} LUFS / TP=${INPUT_TP} dBTP"

GAIN=$(python -c "print(round(-14.0 - float('${INPUT_I}'), 2))")
echo "  施加增益：${GAIN} dB"

echo "[3/4] 归一化到 -14 LUFS / 峰值 -1 dBTP"
"$FF" -y -hide_banner -loglevel error -i mix_raw.wav \
  -af "volume=${GAIN}dB,alimiter=limit=0.86:attack=5:release=60:level=0" \
  -ac 2 -ar 44100 -c:a pcm_s16le mix.wav

echo "[4/4] 合成母版"
"$FF" -y -hide_banner -loglevel error \
  -framerate 30 -i frames/f%04d.png -i mix.wav \
  -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p \
  -b:v 11M -minrate 10.2M -maxrate 11M -bufsize 22M -x264-params nal-hrd=cbr \
  -g 30 -keyint_min 30 -sc_threshold 0 \
  -c:a aac -b:a 192k -ar 44100 \
  -t 30 -movflags +faststart \
  qtvq-30s-v1.mp4

echo
echo "完成：$(pwd)/qtvq-30s-v1.mp4"
"$FF" -hide_banner -i qtvq-30s-v1.mp4 2>&1 | grep -E "Duration|Stream #"
