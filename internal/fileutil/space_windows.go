package fileutil

import "golang.org/x/sys/windows"

// AvailableBytes returns disk space available to the current user.
func AvailableBytes(dir string) (uint64, error) {
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var available uint64
	err = windows.GetDiskFreeSpaceEx(name, &available, nil, nil)
	return available, err
}
