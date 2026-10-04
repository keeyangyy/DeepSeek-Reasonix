package serve

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestDeviceTrustSurvivesARestart is the whole point of the file: a phone that
// scanned once still holds a credential the next process accepts.
func TestDeviceTrustSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "device-trust.json")
	first := newDeviceRegistryAt(time.Now)
	first.persist = func(devices []persistedDevice) { _ = saveDeviceTrust(path, devices) }

	code, _ := first.Offer()
	credential, view, err := first.Redeem(code, "phone")
	if err != nil {
		t.Fatal(err)
	}

	second := newDeviceRegistryAt(time.Now)
	second.Restore(loadDeviceTrust(path))
	id, ok := second.Authenticate(credential)
	if !ok || id != view.ID {
		t.Fatalf("a restarted registry refused the paired credential: id=%q ok=%v want %q", id, ok, view.ID)
	}
	if got := second.Devices(); len(got) != 1 || got[0].Name != view.Name {
		t.Fatalf("restored device list = %+v, want one entry named %q", got, view.Name)
	}
}

// TestUnpairingForgetsTheDeviceOnDisk holds the decision the switch was asked
// for: closing the share unpairs every device, and removing one leaves nothing
// behind to be adopted at the next start.
func TestUnpairingForgetsTheDeviceOnDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device-trust.json")
	reg := newDeviceRegistryAt(time.Now)
	reg.persist = func(devices []persistedDevice) { _ = saveDeviceTrust(path, devices) }

	code, _ := reg.Offer()
	_, view, err := reg.Redeem(code, "phone")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("pairing did not write the trust file: %v", err)
	}

	if !reg.Revoke(view.ID) {
		t.Fatal("revoking a paired device reported no such device")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("removing the last device left its file behind (stat err = %v)", err)
	}

	code, _ = reg.Offer()
	if _, _, err := reg.Redeem(code, "phone"); err != nil {
		t.Fatal(err)
	}
	reg.RevokeAll()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("closing the share left the file behind (stat err = %v)", err)
	}
}

// TestTrustFileWithoutUsableDigestsIsIgnored keeps a damaged or hand-edited file
// from pairing something it cannot authenticate: it reads as no devices.
func TestTrustFileWithoutUsableDigestsIsIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device-trust.json")
	body := `[{"id":"a","digest":"not-hex"},{"id":"","digest":"00"},{"id":"b"},{"id":"c","digest":"0011"}]`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	reg := newDeviceRegistryAt(time.Now)
	reg.Restore(loadDeviceTrust(path))
	if got := reg.Devices(); len(got) != 0 {
		t.Fatalf("unusable entries were adopted: %+v", got)
	}
}

// TestMissingTrustFileReadsAsNoDevices covers the first run, where nothing has
// been written yet.
func TestMissingTrustFileReadsAsNoDevices(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nope", "device-trust.json")
	reg := newDeviceRegistryAt(time.Now)
	reg.Restore(loadDeviceTrust(path))
	if got := reg.Devices(); len(got) != 0 {
		t.Fatalf("a missing file produced devices: %+v", got)
	}
}
