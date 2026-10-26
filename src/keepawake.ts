// Keeps the Deck from going to sleep while it's a controller. The controller is grabbed, so
// Steam never sees any input and its sleep timer runs out mid game. Blocking sleep at the
// system level isn't enough: Steam then gets stuck on its sleep animation. So the sleep
// timers are set to "never" while connected and put back afterwards.
//
// The timers are fields 24003 (on battery) and 24004 (plugged in), in seconds, of the
// settings Steam hands out with RegisterForSettingsArrayChanges and takes with SetSetting
// (same fields DeckyInhibitScreenSaver uses). 0 means never.

const BATTERY = 24003;
const PLUGGED = 24004;
// The user's own timers while we hold them at 0, so a crash or a restart doesn't leave the
// Deck never sleeping.
const BACKUP_KEY = "deck-as-controller.sleepTimers";

type Timers = { battery: number; plugged: number };

function varint(n: number): number[] {
    const out = [];
    do {
        let b = n & 0x7f;
        n = Math.floor(n / 128);
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return out;
}

function readTimers(): Promise<Timers | null> {
    return new Promise((resolve) => {
        // Steam may call back before Register returns, so don't touch the handle in there.
        let done = false;
        const finish = (t: Timers | null) => {
            if (done) return;
            done = true;
            setTimeout(() => handle.unregister(), 0);
            resolve(t);
        };
        setTimeout(() => finish(null), 3000);
        const handle = SteamClient.Settings.RegisterForSettingsArrayChanges((buf) => {
            if (done) return;
            const b = new Uint8Array(buf);
            const found: Record<number, number> = {};
            let i = 0;
            const read = () => {
                let r = 0, shift = 0, x;
                do {
                    x = b[i++];
                    r += (x & 0x7f) * 2 ** shift;
                    shift += 7;
                } while (x & 0x80);
                return r;
            };
            while (i < b.length) {
                const key = read(), field = Math.floor(key / 8), wire = key % 8;
                if (wire === 0) {
                    const v = read();
                    if (field === BATTERY || field === PLUGGED) found[field] = v;
                } else if (wire === 1) i += 8;
                else if (wire === 2) {
                    const len = read();  // not i += read(): that adds to i from before the read
                    i += len;
                }
                else if (wire === 5) i += 4;
                else break;
            }
            finish(BATTERY in found && PLUGGED in found
                ? { battery: found[BATTERY], plugged: found[PLUGGED] } : null);
        });
    });
}

async function writeTimers(t: Timers) {
    const bytes = [...varint(BATTERY << 3), ...varint(t.battery),
                   ...varint(PLUGGED << 3), ...varint(t.plugged)];
    await SteamClient.Settings.SetSetting(btoa(String.fromCharCode(...bytes)));
}

function loadBackup(): Timers | null {
    try {
        return JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
    } catch {
        return null;
    }
}

let busy = Promise.resolve();

// Hold the sleep timers at "never" (on) or give the user's back (off). Safe to call often.
export function keepAwake(on: boolean) {
    busy = busy.then(async () => {
        const backup = loadBackup();
        if (on && !backup) {
            const timers = await readTimers();
            if (!timers || (timers.battery === 0 && timers.plugged === 0)) return;
            localStorage.setItem(BACKUP_KEY, JSON.stringify(timers));
            await writeTimers({ battery: 0, plugged: 0 });
        } else if (!on && backup) {
            await writeTimers(backup);
            localStorage.removeItem(BACKUP_KEY);
        }
    }).catch((e) => console.error("Deck as Controller: sleep timers", e));
}
