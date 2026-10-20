package checkpoint

import fileenc "reasonix/internal/fileutil/encoding"

// encodeForWrite renders a revision's content back into the encoding it was read
// in, preferring the recorded kind and falling back to the file's current one.
//
// A character the target charset cannot hold is returned as an error rather than
// substituted: writing a replacement would silently rewrite bytes the edit never
// touched, which is worse than refusing the write.
func (s *Store) encodeForWrite(rev FileRevision, abs string) ([]byte, error) {
	enc := fileenc.UTF8
	if rev.Encoding != nil {
		enc = *rev.Encoding
	} else if current := s.detectCurrentEncoding(abs); current != nil {
		enc = *current
	}
	return fileenc.Encode(*rev.Content, enc)
}
