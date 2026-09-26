# Everything here runs as root. Claude Code refuses --dangerously-skip-permissions
# as root unless it is told it is in a sandbox — this live system is one.
export IS_SANDBOX=1
