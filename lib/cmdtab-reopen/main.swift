// cmdtab-reopen — the daemon behind bin/cmdtab-reopen.
//
// ⌘Tab only activates an application; a click on its Dock icon also sends it the
// "reopen" Apple Event, which is what makes most apps open a window when they
// have none. This daemon watches activations, and when one came from ⌘Tab and
// the application shows no window, sends that same reopen event — so ⌘Tab
// behaves like the Dock.
//
// The wrapper script (cmdtab-reopen) builds this file and runs it under launchd;
// its --help documents the behavior.

import Cocoa

let verbose = CommandLine.arguments.contains("--verbose")
let ignored: Set<String> = {
	let path = (ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"] ?? NSHomeDirectory() + "/.config")
		+ "/cmdtab-reopen/ignore"
	guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
	return Set(text.split(whereSeparator: \.isNewline)
		.map { $0.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0] }
		.map { $0.trimmingCharacters(in: .whitespaces) }
		.filter { !$0.isEmpty })
}()

func log(_ message: String) {
	let stamp = ISO8601DateFormatter().string(from: Date())
	FileHandle.standardError.write("\(stamp) \(message)\n".data(using: .utf8)!)
}

func since(_ type: CGEventType) -> Double {
	CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type)
}

// ⌘Tab switches on the release of ⌘: the last input before the activation is a
// modifier change, newer than the last key press (Tab) and the last click. An
// activation by a click (Dock, a window, Mission Control) or by typing (Spotlight,
// Raycast — those send reopen themselves) fails one of the comparisons.
func cameFromCommandTab() -> Bool {
	let flags = since(.flagsChanged)
	let key = since(.keyDown)
	let click = min(since(.leftMouseDown), since(.rightMouseDown), since(.otherMouseDown))
	if verbose { log(String(format: "  input: flags %.3fs, key %.3fs, click %.3fs ago", flags, key, click)) }
	return flags < 0.5 && key < 2 && flags < key && flags < click
}

// A window the user would call "open": a normal-level window of the process,
// on screen in the current Space, not a sliver. Minimized, hidden and
// ordered-out windows are not on screen, and neither are those of another Space
// — but activating an app whose windows sit in another Space switches Spaces,
// which is why the check is repeated over the switch animation.
func hasVisibleWindow(_ pid: pid_t) -> Bool {
	guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
		as? [[String: Any]] else { return true }
	return list.contains { w in
		guard (w[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
			(w[kCGWindowLayer as String] as? Int) == 0,
			(w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
			let bounds = w[kCGWindowBounds as String] as? [String: Double],
			(bounds["Width"] ?? 0) >= 100, (bounds["Height"] ?? 0) >= 100
		else { return false }
		return true
	}
}

let checks: [Double] = [0.15, 0.4, 0.8]
var generation = 0

func onActivate(_ app: NSRunningApplication) {
	generation += 1
	let mine = generation
	let name = app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)"
	if verbose { log("activated \(name)") }

	guard app.activationPolicy == .regular,
		app.processIdentifier != getpid(),
		let url = app.bundleURL
	else { return }
	if let id = app.bundleIdentifier, ignored.contains(id) {
		if verbose { log("  ignored by config") }
		return
	}
	// Launching apps activate before their first window exists.
	if let launched = app.launchDate, Date().timeIntervalSince(launched) < 5 { return }
	guard cameFromCommandTab() else { return }

	func check(_ index: Int) {
		DispatchQueue.main.asyncAfter(deadline: .now() + checks[index] - (index > 0 ? checks[index - 1] : 0)) {
			// Another activation since then, or the user already moved on.
			guard mine == generation,
				NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
				!app.isTerminated
			else { return }
			if hasVisibleWindow(app.processIdentifier) {
				if verbose { log("  \(name) has a window") }
				return
			}
			if index + 1 < checks.count { return check(index + 1) }

			log("reopen \(name)")
			let config = NSWorkspace.OpenConfiguration()
			config.activates = true
			config.addsToRecentItems = false
			NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
				if let error { log("reopen \(name) failed: \(error.localizedDescription)") }
			}
		}
	}
	check(0)
}

NSWorkspace.shared.notificationCenter.addObserver(
	forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
	if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
		onActivate(app)
	}
}

if !ignored.isEmpty { log("ignoring \(ignored.sorted().joined(separator: ", "))") }
log("watching activations")
RunLoop.main.run()
