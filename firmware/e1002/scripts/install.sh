#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

meal_enabled=1
weather_enabled=0
if [[ -f .local/features.env ]]; then
  while IFS='=' read -r key value; do
    if [[ "$key" == "FEATURE_MEAL" && "$value" == "0" ]]; then
      meal_enabled=0
    fi
    if [[ "$key" == "FEATURE_WEATHER" && "$value" == "1" ]]; then
      weather_enabled=1
    fi
  done < .local/features.env
fi

selected=1
module_count=2

checkbox() {
  local index="$1"
  local enabled="$2"
  local label="$3"
  local cursor=" "
  local mark=" "
  if [[ "$selected" -eq "$index" ]]; then
    cursor=">"
  fi
  if [[ "$enabled" -eq 1 ]]; then
    mark="x"
  fi
  echo "  $cursor [$mark] $label"
}

print_menu() {
  printf '\033[2J\033[H'
  echo "E1002 firmware module selection"
  echo
  echo "Required:"
  echo "  [x] Codex quota dashboard"
  echo "  [x] Wi-Fi setup portal"
  echo "  [x] Deep sleep and three-button navigation"
  echo
  echo "Optional:"
  checkbox 1 "$meal_enabled" "Daily meal page"
  checkbox 2 "$weather_enabled" "Weather page"
  echo
  echo "Use Up/Down or 1/2 to choose a module."
  echo "Press Space to toggle, Enter to continue, q to cancel."
}

toggle_selected() {
  case "$selected" in
    1)
      if [[ "$meal_enabled" -eq 1 ]]; then meal_enabled=0; else meal_enabled=1; fi
      ;;
    2)
      if [[ "$weather_enabled" -eq 1 ]]; then weather_enabled=0; else weather_enabled=1; fi
      ;;
  esac
}

select_previous() {
  if [[ "$selected" -le 1 ]]; then
    selected="$module_count"
  else
    selected=$((selected - 1))
  fi
}

select_next() {
  if [[ "$selected" -ge "$module_count" ]]; then
    selected=1
  else
    selected=$((selected + 1))
  fi
}

read_escape_sequence() {
  local second=""
  local third=""
  IFS= read -rsn1 -t 1 second || return 0
  case "$second" in
    "["|"O")
      IFS= read -rsn1 -t 1 third || return 0
      printf '%s%s' "$second" "$third"
      ;;
    *)
      printf '%s' "$second"
      ;;
  esac
}

while true; do
  print_menu
  key=""
  IFS= read -rsn1 key || true
  case "$key" in
    " ")
      toggle_selected
      ;;
    1) selected=1 ;;
    2) selected=2 ;;
    j|J) select_next ;;
    k|K) select_previous ;;
    $'\033')
      key="$(read_escape_sequence)"
      case "$key" in
        "[A"|"OA") select_previous ;;
        "[B"|"OB") select_next ;;
      esac
      ;;
    "")
      break
      ;;
    q|Q)
      echo "Cancelled."
      exit 0
      ;;
  esac
done

mkdir -p .local
cat > .local/features.env <<EOF
FEATURE_MEAL=$meal_enabled
FEATURE_WEATHER=$weather_enabled
EOF
chmod 600 .local/features.env

echo
echo "Saved feature selection:"
echo "  FEATURE_MEAL=$meal_enabled"
echo "  FEATURE_WEATHER=$weather_enabled"
echo "  PIO_ENV=reterminal_e1002"
echo
echo "Next step:"
echo "  1) Save only"
echo "  2) Build firmware"
echo "  3) Build and flash firmware"
echo
read -r -p "Choose 1, 2, or 3: " action

case "$action" in
  1)
    echo "Selection saved."
    ;;
  2)
    scripts/build.sh
    ;;
  3)
    scripts/flash.sh
    ;;
  *)
    echo "Unknown choice; selection saved only."
    ;;
esac
