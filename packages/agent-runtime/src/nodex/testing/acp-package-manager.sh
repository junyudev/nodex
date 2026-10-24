#!/bin/sh
"$0.real" "$@" || exit $?
if [ "$1" != "install" ] && [ "$2" != "install" ]; then exit 0; fi
printf 'partial' > "$ACP_PARTIAL_READY"
mode="$(cat "$ACP_INSTALL_MODE")"
if [ "$mode" = "fail" ]; then exit 41; fi
if [ "$mode" = "cancel" ]; then exec sleep 30; fi
root="${npm_config_prefix:-$UV_TOOL_DIR}"
printf 'complete' > "$root/postinstall-complete"
if [ "$1" = "tool" ]; then command_name=fast-agent; else command_name=example-agent; fi
printf '#!/bin/sh\n[ -f "%s/postinstall-complete" ]\n' "$root" > "$root/bin/$command_name"
chmod 755 "$root/bin/$command_name"
