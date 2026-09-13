# Linux USB access for module authors

If a USB device is visible but opening it reports `LIBUSB_ERROR_ACCESS`, check
the permissions on its device node before changing the module. A read-only
protocol operation still needs read/write access to the USB node: it must send
requests and claim an interface. `pdr inspect` only admits the module; it does
not prove device access.

## Identify the current USB personality

Run `lsusb` (from your distribution's `usbutils` package). For example, the
NES Classic in FEL recovery mode reports `1f3a:efe8`; normal boot reports
`057e:2041`. These are two personalities of the same console, with different
endpoints and protocols. Use your device's current vendor and product IDs,
not IDs borrowed from a worked module.

An entry saying `Bus 001 Device 023` names `/dev/bus/usb/001/023`:

```bash
ls -l /dev/bus/usb/001/023
id
```

Substitute the bus and device numbers from your own `lsusb` output. They can
change after reconnection. A `root:root` node with mode `0664` gives an ordinary
user read access but no write access. Joining `dialout` does not generally fix
access to `/dev/bus/usb/` nodes; serial TTY permissions are a separate policy.

## One run with sudo, without installing a rule

For a CLI trial, invoke the bundled launcher with `sudo`. Replace the module
path and operation below with yours; `pdr run /absolute/path/to/your-module`
lists that module's generated operations without opening it.

```bash
sudo -- ./protodriver-linux-x64/bin/pdr run /absolute/path/to/your-module your-operation
```

Use `protodriver-linux-arm64` for the arm64 package. No system Node is needed.
This runs the CLI as root for that invocation; capture and saved-result files
it creates may be root-owned. It changes no persistent device-access policy.
Running `pdr-web` with sudo does not grant a separately running browser USB
access. For the browser, grant access to the user running the browser through
the rule below, and keep the browser unprivileged.

## Persistent access through a dedicated group

This example works for terminal and SSH users as well as a desktop session.
Create the group once, then add your ordinary login account:

```bash
getent group protodriver-usb
# If the group does not exist:
sudo groupadd --system protodriver-usb
sudo usermod -aG protodriver-usb "$(id -un)"
sudoedit /etc/udev/rules.d/70-protodriver-usb.rules
```

Put this rule in the file for the NES Classic's FEL personality. For another
device, substitute its measured four-digit hexadecimal vendor and product IDs.
The rule grants access only to members of `protodriver-usb`:

```udev
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="1f3a", ATTR{idProduct}=="efe8", GROUP="protodriver-usb", MODE="0660"
```

If you also intend to access the console's normal-boot USB personality, add a
separate rule for it:

```udev
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="057e", ATTR{idProduct}=="2041", GROUP="protodriver-usb", MODE="0660"
```

The second rule does not make a FEL module work in normal boot. Permission
and the module's protocol/profile match are independent requirements.

Reload the rules, then disconnect and reconnect the device in the required
mode:

```bash
sudo udevadm control --reload-rules
```

Reloading rules alone does not update an already present device. Log out and
back in (start a new SSH login if applicable) so your processes inherit the new
group membership. Check `id`, run `lsusb` again, and inspect the new node: its
group should be `protodriver-usb` with group read/write permission. Retry the
CLI without sudo, or restart the browser from the new login session.

If the device reappears under another VID:PID, restore its required physical
mode first. Permission rules cannot put it back into a boot ROM or recovery
mode. An interface-busy or kernel-driver error after access succeeds is a
different failure; changing node permissions does not release another owner.

To withdraw this access, remove your device's lines with `sudoedit`, reload
the rules, and reconnect the device. No rule is installed automatically by the
release. Rule matching and group/mode assignments follow
[systemd's udev documentation](https://github.com/systemd/systemd/blob/main/man/udev.xml);
reload behavior is documented in
[udevadm](https://github.com/systemd/systemd/blob/main/man/udevadm.xml).
