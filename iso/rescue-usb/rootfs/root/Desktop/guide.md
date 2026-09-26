# Спасательная флешка: что случилось → чем смотреть → как чинить

Открыть этот файл в терминале — `guide`. Всё ниже есть в образе. `man <команда>`
или `<команда> --help` — подробности; документация SystemRescue — иконка
«Manual» на панели. Можно и так: `claude`, описать симптом и попросить
разобраться (после логина) — этот гайд Claude на флешке уже знает.

## 0. Прежде чем что-то чинить

- **Система живёт в RAM.** Всё, что создано в `/root`, пропадёт при перезагрузке,
  если на флешке нет persistence (`vtoycow` у Ventoy). Бэкапы, образы дисков и
  логи сохраняй на **другой** диск, не на тот, который чинишь.
- **Сначала бэкап, потом ремонт.** Таблица разделов — `sgdisk --backup`, умирающий
  диск — `ddrescue` целиком (раздел 4). Одна команда ремонта на сбойном диске
  может убить то, что ещё читалось.
- **Проверяй, какой это диск:** `lsblk -o NAME,SIZE,MODEL,SERIAL`. Путать `sda` и
  `sdb` при `dd`, `wipe` или `gdisk` — классика.
- Меню загрузки флешки полезно само по себе:
  - `nomodeset` — чёрный экран или артефакты вместо рабочего стола;
  - `copytoram` — всё в RAM, флешку можно вынуть;
  - `findroot` — загрузить Linux, установленный на диске, когда у него сломан загрузчик;
  - `Memtest86+` — проверка памяти (раздел 6);
  - `EFI Firmware setup` — войти в настройки BIOS/UEFI, не ловя F2/Del.

## 1. Осмотреться: что за машина и что за диски

| Вопрос | Команда |
|---|---|
| Сводка по железу | `inxi -Fxxz` |
| Модель, серийник, версия BIOS | `dmidecode -t system -t bios` |
| Устройства и их драйверы | `lspci -k`, `lsusb`, `lshw -short`, `hwinfo --short` |
| Диски, разделы, файловые системы | `lsblk -o NAME,SIZE,TYPE,PTTYPE,FSTYPE,LABEL,PARTTYPENAME,MOUNTPOINTS` |
| Таблица разделов подробно | `fdisk -l /dev/sdX` (`Disklabel type: gpt` или `dos` = MBR) |
| UUID и метки | `blkid` |
| Как загрузилась **эта** флешка | `[ -d /sys/firmware/efi ] && echo UEFI \|\| echo BIOS/Legacy` |
| Что сейчас пишет ядро (вставил диск, флешку, кабель) | `dmesg -Tw` |
| Температуры и вентиляторы | `sensors` |

Графика: GParted (разделы), GSmartControl (SMART), Firefox, FeatherPad.

## 2. Не загружается ОС

### 2.1. Режим прошивки и разметка диска не совпадают

Прошивка грузит одним из двух способов, и диск должен ему соответствовать:

| Прошивка грузит в режиме | Диск должен быть | Загрузчик лежит |
|---|---|---|
| **Legacy / BIOS / CSM** | **MBR** (`dos`), раздел с ОС помечен активным | код в MBR + загрузочный сектор раздела |
| **UEFI** | **GPT** (UEFI умеет и MBR, но Windows в режиме UEFI ставится только на GPT) | файл `.efi` на разделе EFI (FAT32, ~100–500 МБ) |

Симптом: «No bootable device», «Operating system not found», мигающий курсор,
а в настройках BIOS диск при этом виден.

**Диагностика.**
1. `fdisk -l /dev/sdX`: `gpt` или `dos`? Есть ли раздел `EFI System`?
2. Как грузится машина. Загрузи флешку так же, как пыталась грузиться ОС, и
   посмотри `ls /sys/firmware/efi`: каталог есть — UEFI, нет — Legacy. Или
   зайди в настройки прошивки: Boot Mode / UEFI / CSM / Legacy Support.

**Случай: старый ноут грузит Legacy, а диск переразметили в GPT** (Windows
ставили в режиме UEFI).

- **Вариант А, проще всего.** Если в настройках есть UEFI или «UEFI + Legacy»,
  включи UEFI и выбери «Windows Boot Manager». Больше ничего не трогай.
- **Вариант Б: прошивка умеет только Legacy.** Переводим диск в MBR без потери данных.
  1. Бэкап таблицы разделов — на другой носитель:
     `sgdisk --backup=/mnt/usb/sdX-gpt.bin /dev/sdX`
     (откат: `sgdisk --load-backup=/mnt/usb/sdX-gpt.bin /dev/sdX`).
  2. Ограничения MBR: не больше 4 основных разделов и диск до 2 ТиБ. У Windows на
     GPT обычно так: EFI, MSR (16 МБ, без ФС), C:, Recovery. MSR для MBR не
     нужен, его можно удалить заранее (`gdisk` → `d`), тогда разделов 3.
  3. `gdisk /dev/sdX` → `r` (recovery/transformation) → `g` (convert GPT into
     MBR) → выбрать разделы → `w`.
  4. Код MBR Windows: `ms-sys -7 /dev/sdX` (подходит для Windows 7–11).
  5. Сделать раздел C: активным: `sfdisk --activate /dev/sdX <номер>`.
  6. Остальное делается только из среды Windows: загрузить установочную флешку
     Windows в режиме **Legacy**, «Восстановление системы» → «Командная строка»:
     `bcdboot C:\Windows /s C: /f BIOS`, затем `bootrec /fixmbr` и `bootrec /fixboot`.
     Буква диска там может отличаться — проверь `dir C:\Windows`.
- **Обратный случай: новая машина без CSM (только UEFI), а диск MBR.** Из
  работающей Windows: `mbr2gpt /convert /allowFullOS`. Если Windows не грузится,
  то из среды восстановления Windows: `mbr2gpt /validate /disk:0`, затем
  `mbr2gpt /convert /disk:0` (номер диска — `diskpart` → `list disk`).

### 2.2. UEFI: пропал пункт загрузки

После обновления прошивки, замены батарейки или «сброса BIOS» список загрузки
бывает пустым, хотя файлы на месте.
- Посмотреть: `efibootmgr -v` (флешка должна быть загружена в режиме UEFI).
- Вернуть Windows:
  `efibootmgr -c -d /dev/sdX -p <номер EFI-раздела> -L "Windows Boot Manager" -l '\EFI\Microsoft\Boot\bootmgfw.efi'`
- Вернуть Linux: сначала проверь, что лежит в `\EFI\` на разделе EFI, и укажи
  путь к его `grubx64.efi` / `shimx64.efi`.
- Порядок загрузки: `efibootmgr -o 0001,0000`.

### 2.3. Linux: сломан GRUB

1. Самое быстрое: пункт `findroot` в меню флешки загружает установленную систему.
   Уже из неё: `grub-install` и `update-grub` (или `grub-mkconfig`).
2. Вручную, из флешки:
   ```sh
   mount /dev/sdX2 /mnt              # корень системы
   mount /dev/sdX1 /mnt/boot/efi     # раздел EFI (в Arch часто /mnt/boot)
   arch-chroot /mnt                  # работает для любого дистрибутива
   grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=GRUB
   grub-mkconfig -o /boot/grub/grub.cfg    # в Debian/Ubuntu: update-grub
   ```
   Для Legacy: `grub-install --target=i386-pc /dev/sdX`.
   Чтобы GRUB видел Windows, нужен `os-prober` **внутри** системы, в которую
   сделан chroot, и `GRUB_DISABLE_OS_PROBER=false` в её `/etc/default/grub`.

### 2.4. Windows: «диск грязный», синий экран при старте

- `chkdsk` бывает только в Windows (среда восстановления → командная строка →
  `chkdsk C: /f`). Из Linux настоящей проверки NTFS нет.
- `ntfsfix -d /dev/sdX3` только снимает флаг «грязный» и чинит мелочи. Это не
  замена chkdsk, зато помогает, когда нужно лишь смонтировать раздел.

## 3. Смонтировать чужой диск

| Что | Как |
|---|---|
| NTFS | `mount -t ntfs3 /dev/sdX3 /mnt` (быстрее) или `mount -t ntfs-3g …` |
| NTFS после «Быстрого запуска» или гибернации Windows | ядро откажется писать: `mount -t ntfs3 -o ro …`. Запись возможна через `ntfs-3g -o remove_hiberfile`, но сессия Windows при этом пропадёт. Лучше отключить быстрый запуск в самой Windows |
| BitLocker | `cryptsetup bitlkOpen /dev/sdX3 win` (попросит пароль или ключ восстановления), затем `mount /dev/mapper/win /mnt`. Запасной путь — `dislocker` |
| LUKS (шифрованный Linux) | `cryptsetup open /dev/sdX2 root` → `mount /dev/mapper/root /mnt` |
| LVM | `vgchange -ay`, `lvs`, затем `mount /dev/<vg>/<lv> /mnt` |
| Программный RAID | `mdadm --assemble --scan`, `cat /proc/mdstat` |
| ext4 / xfs / btrfs / exFAT / FAT | просто `mount`; проверка ФС — раздел 4.3 |
| Сетевая шара Windows (SMB) | `mount -t cifs //host/share /mnt -o username=user` |
| Каталог по ssh | `sshfs user@host:/path /mnt` |
| Облако | `rclone config`, затем `rclone copy` / `rclone mount` |
| Образ диска | `losetup -Pf --show disk.img` → разделы видны как `/dev/loopNpM` |

## 4. Диск сбоит или умирает

### 4.1. Здоров ли диск

- SATA: `smartctl -H -A /dev/sdX`. Плохие признаки: растущие
  `Reallocated_Sector_Ct` (5), `Current_Pending_Sector` (197),
  `Offline_Uncorrectable` (198). `UDMA_CRC_Error_Count` (199) указывает на кабель
  или разъём, а не на сам диск.
- NVMe: `smartctl -a /dev/nvme0` или `nvme smart-log /dev/nvme0`. Смотри на
  `critical_warning`, `media_errors`, `percentage_used`.
- Тест: `smartctl -t short /dev/sdX` (2 минуты) или `-t long` (часы), результат:
  `smartctl -l selftest /dev/sdX`.
- В графике: GSmartControl.
- Поверхность, только чтение: `badblocks -sv /dev/sdX`. **Никогда не запускай
  `badblocks -w` на диске с данными** — он пишет поверх.
- Ошибки чтения в момент работы: `dmesg -Tw` (ищи `I/O error`, `UNC`, `reset`).

### 4.2. Спасти данные с умирающего диска

Сначала образ, потом всё остальное. Каждое лишнее чтение может добить диск.
```sh
# куда-то, где места больше, чем объём всего диска-донора
ddrescue -d -n  /dev/sdX /mnt/big/disk.img /mnt/big/disk.map   # сначала всё, что читается легко
ddrescue -d -r3 /dev/sdX /mnt/big/disk.img /mnt/big/disk.map   # потом добивать сбойные места
```
Прерывать можно: с тем же `disk.map` ddrescue продолжит с места остановки.
Дальше работаем с `disk.img` (`losetup`, `testdisk`, `photorec`), а не с диском.

### 4.3. Проверить и починить файловую систему

Только на **несмонтированном** разделе.
- ext2/3/4: `fsck.ext4 -f /dev/sdX2`.
- xfs: `xfs_repair -n /dev/sdX2` (только посмотреть), затем без `-n`.
- btrfs: `btrfs check --readonly /dev/sdX2`. `--repair` — последнее средство,
  после бэкапа.
- FAT/exFAT: `fsck.vfat -a` / `fsck.exfat`.

### 4.4. Скорость и нагрузка

- Линейное чтение: `hdparm -tT /dev/sdX`.
- Точнее, без записи на диск:
  `fio --name=read --filename=/dev/sdX --readonly --rw=read --bs=1M --direct=1 --runtime=30 --time_based`.
- Кто сейчас грузит диск: `iotop`. Общая картина: `btop`, `nmon`.
- Что занимает место: `gdu /mnt` или `ncdu /mnt`.

## 5. Удалили раздел или файлы

- **Пропал раздел или вся таблица разделов:** `testdisk /dev/sdX` → Analyse →
  Quick Search → найденные разделы → Write. Спасает и «я случайно создал новую
  таблицу разделов».
- **Удалённые файлы, отформатированный раздел:** `photorec /dev/sdX` (или
  образ). Восстанавливает по сигнатурам, без имён файлов. Складывать найденное
  — на **другой** диск.
- Ещё: `foremost` (тоже по сигнатурам); `sleuthkit` (`fls`, `icat`) —
  когда нужны имена файлов и понимание структуры ФС.

## 6. Память, процессор, перегрев

- Память: пункт `Memtest86+` в меню загрузки флешки (минимум один полный
  проход). Из работающей системы можно проще, но хуже: `memtester 2G 1`.
- Нагрузить процессор и смотреть на температуру: `stress-ng --cpu 0 --timeout 10m`
  в одном окне, `watch -n2 sensors` в другом.
- Следы аппаратных сбоев: `dmesg -T | rg -i 'mce|machine check|thermal|throttl'`.
- Серверы: `ipmitool sensor`, `ipmitool sel list`.

## 7. Сеть

### 7.1. Подключиться

- Wi-Fi и проводная: `nmtui`, или иконка NetworkManager на панели, или
  `nmcli dev wifi connect <SSID> password <пароль>`.
- Что с интерфейсами: `ip -br a`, маршруты: `ip r`.

### 7.2. «Интернет не работает»: по слоям снизу вверх

| Слой | Проверка |
|---|---|
| Кабель и линк | `ethtool eth0`: `Link detected`, `Speed`, `Duplex`. 100 Мбит/с на гигабитном порту обычно означает плохой кабель |
| Wi-Fi | `iw dev wlan0 link` (сигнал, скорость), `nmcli dev wifi list`; `wavemon` — сигнал и шум вживую, удобно ходить с ноутом и искать мёртвые зоны |
| Адрес по DHCP | есть ли адрес в `ip -br a`; в чём дело: `tcpdump -ni eth0 port 67 or port 68` |
| Шлюз | `ping -c3 $(ip r \| awk '/default/{print $3; exit}')` |
| Интернет по IP | `ping -c3 1.1.1.1` |
| DNS | `dig ya.ru`, затем `dig ya.ru @1.1.1.1`: второй работает, а первый нет — значит, виноват DNS роутера или провайдера |
| Где теряются пакеты | `trip ya.ru` (TUI: хопы, потери, задержки) или `mtr -rwzbc 50 ya.ru`; нестабильность во времени — `gping ya.ru 1.1.1.1 <шлюз>` |
| HTTPS, сертификаты, прокси | `curl -v https://ya.ru`; сервер целиком (протоколы, шифры, цепочка) — `testssl ya.ru` |
| Скорость до интернета | `speedtest-cli` |
| Скорость внутри сети | `iperf3 -s` на одной машине, `iperf3 -c <ip>` на другой; сколько идёт через интерфейс прямо сейчас — `nload` |
| Адреса и маски | `ipcalc 192.168.1.10/22` — сеть, broadcast, диапазон хостов |

### 7.3. Кто есть в сети и кто её грузит

- Устройства в сегменте: `arp-scan -l` или `nmap -sn 192.168.1.0/24`; живы ли
  хосты из списка — `fping -a -g 192.168.1.0/24` или `fping < hosts.txt`.
- Имена Windows-машин: `nbtscan 192.168.1.0/24`.
- Свитчи, принтеры, UPS по SNMP: `snmpwalk -v2c -c public <ip>` (дальше —
  `snmpwalk … IF-MIB::ifOperStatus` для портов).
- Порты и сервисы на хосте: `nmap -sV <ip>`.
- В какой порт какого свитча воткнут кабель: `systemctl start lldpd`, подождать
  минуту, затем `lldpcli show neighbors`.
- Кто съедает канал: `bandwhich` (процессы, соединения и адреса разом), `nethogs`
  (по процессам), `iftop` (по соединениям).
- Смотреть трафик: `tcpdump -ni eth0 host <ip>` или `tshark -i eth0 -f 'port 53'`;
  с разбором пакетов, как в Wireshark, но в терминале — `termshark -i eth0`;
  искать строку в содержимом — `ngrep -d eth0 -q 'Host:' port 80`.

## 8. Удалённая помощь

- **Tailscale:** `tailscale up`, затем открыть ссылку и залогиниться.
  `tailscale up --ssh` включает Tailscale SSH: заходить можно без паролей и
  без открытых портов. Входящие на `tailscale0` файрвол уже пропускает.
- Обычный ssh: задать пароль root (`passwd`), и `sshd` уже слушает. Снаружи
  сети файрвол его закрывает, через Tailscale доступ открыт.
- `mosh` — ssh, который переживает плохую связь. Ещё есть `wireguard-tools` и `openvpn`.
- Удалённый рабочий стол: Remmina (RDP/VNC); отдать свой экран — `x11vnc`.

## 9. Windows: пароль, образы, архивы

- Сбросить пароль **локальной** учётки: смонтировать C: на запись (см. раздел 3
  про быстрый запуск), затем
  `chntpw -i /mnt/Windows/System32/config/SAM` → выбрать пользователя →
  «Clear (blank) user password», можно ещё «Unlock and enable». Учётки Microsoft
  так не сбрасываются.
- Образы установки Windows (`install.wim` / `.esd`): `wimlib-imagex info|apply|extract`.
- Архивы: `7z x`, `unrar x`, `unzip`.

## 10. Клонировать и бэкапить

- Целиком, с меню и понятными вопросами: `clonezilla`.
- Раздел в образ с учётом ФС (копируются только занятые блоки):
  `partclone.ntfs -c -s /dev/sdX3 -o /mnt/big/c.img` (есть `.ext4`, `.xfs`, `.vfat` и т. д.).
- Файловая система в архив с восстановлением на раздел другого размера:
  `fsarchiver savefs /mnt/big/root.fsa /dev/sdX2`, `fsarchiver restfs …`.
- Сырая копия с прогрессом: `pv /dev/sdX > /mnt/big/disk.img` (для сбойных
  дисков — только `ddrescue`).
- Файлы: `rsync -aHAX --info=progress2 /mnt/src/ /mnt/dst/`.
- Конвертировать образ диска для виртуалки: `qemu-img convert -O qcow2 disk.img disk.qcow2`.

## 11. Стереть диск насовсем

**Необратимо. Трижды проверь `lsblk -o NAME,SIZE,MODEL,SERIAL`.**
- HDD: `nwipe` (меню, методы, отчёт).
- SSD (SATA): `blkdiscard /dev/sdX`. Полный secure erase: в `hdparm -I /dev/sdX`
  должно быть `not frozen` (если `frozen` — усыпить машину и разбудить), затем
  `hdparm --user-master u --security-set-pass p /dev/sdX` и
  `hdparm --user-master u --security-erase p /dev/sdX`.
- NVMe: `nvme format /dev/nvme0n1 --ses=1` (стирание пользовательских данных).

## 12. Сама флешка и эта система

- Пакеты ставятся сразу, без `-Sy`: `pacman -S <пакет>` (база и зеркала —
  на дату выпуска SystemRescue, это не сломает систему). Свежие версии —
  `pacman --config /etc/pacman-rolling.conf -Sy <пакет>`, но на свой страх и риск.
- Мои конфиги и тулы — в `~/toolbox`; обновить: `git -C ~/toolbox pull`.
- Раскладка: Super+Пробел переключает us/ru.
