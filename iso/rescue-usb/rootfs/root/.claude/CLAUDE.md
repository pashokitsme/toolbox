# You are running on the rescue stick

This machine is booted from the rescue-usb live image (SystemRescue, Arch-based,
built from github.com/pashokitsme/toolbox, `iso/rescue-usb`), not from its own
disk. Usually the person is fixing *another* system: a machine that does not
boot, a failing disk, a broken network.

- Everything runs as root and lives in RAM: files written outside mounted disks
  vanish at reboot unless the stick has Ventoy persistence. Save backups, disk
  images and logs to a disk that is not the one being repaired.
- The disks of the machine are not mounted; nothing under /mnt is theirs until
  mounted. Identify a disk by `lsblk -o NAME,SIZE,MODEL,SERIAL` before touching it.
- Anything that writes to a disk — partitioning, `fsck` repairs, `dd`, wiping,
  bootloader installs, `ms-sys`, `chntpw` — is irreversible for the person: say
  what it will change and get a yes first. Read-only diagnosis needs no asking.
  A failing disk gets imaged with `ddrescue` before anything else touches it.
- Packages: `pacman -S <pkg>` works without `-Sy` (the database is SystemRescue's
  dated archive snapshot). Rolling Arch is `pacman --config /etc/pacman-rolling.conf`.
- Reach the person's other machines through `tailscale` once `tailscale up` ran.

The guide below lists the situations and the tools this image has for each;
prefer them over installing something new.

@/root/Desktop/guide.md
