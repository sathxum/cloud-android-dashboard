#!/usr/bin/env bash
# Boots one Android emulator + ws-scrcpy web mirror on $DEVICE_PORT.
# Env: DEVICE_NAME DEVICE_PORT ANDROID_API DEVICE_PROFILE RAM_MB STORAGE_MB CORES
set -e

NAME="${DEVICE_NAME:-device}"
PORT="${DEVICE_PORT:-9100}"
API="${ANDROID_API:-31}"
PROFILE="${DEVICE_PROFILE:-pixel_6}"
RAM="${RAM_MB:-4096}"
STORAGE="${STORAGE_MB:-10240}"
CORES="${CORES:-4}"
AVD="avd_${NAME}"

echo "[boot] $NAME api=$API profile=$PROFILE ram=${RAM}M storage=${STORAGE}M cores=$CORES port=$PORT"

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
SDK="$ANDROID_SDK_ROOT"
PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"

# Apple Silicon (arm64) macOS runners need arm64-v8a images.
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then ABI="arm64-v8a"; else ABI="x86_64"; fi
PKG="system-images;android-${API};google_apis;${ABI}"
echo "[boot] host arch=$ARCH -> ABI=$ABI"
yes | sdkmanager "$PKG" "platform-tools" "emulator" >/dev/null 2>&1 || true

# create AVD (idempotent)
echo "no" | avdmanager create avd -n "$AVD" -k "$PKG" -d "$PROFILE" --force >/dev/null 2>&1 || true

# boot headless with requested resources
emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -memory "$RAM" -cores "$CORES" -partition-size "$STORAGE" \
  -port $((5554 + (PORT % 100) * 2)) >/tmp/emu_${NAME}.log 2>&1 &

adb wait-for-device
# wait for full boot
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done

echo "[boot] emulator booted. Real specs:"
RRAM=$(( $(adb shell cat /proc/meminfo | awk '/MemTotal/{print $2}') / 1024 ))
RCORES=$(adb shell cat /proc/cpuinfo | grep -c ^processor)
echo "[boot] RAM=${RRAM}MB cores=${RCORES}"

# start ws-scrcpy on the device port
export WS_SCRCPY_PORT="$PORT"
ws-scrcpy --port "$PORT" >/tmp/ws_${NAME}.log 2>&1 &
sleep 6
echo "WS_SCRCPY_READY $NAME $PORT"
wait
