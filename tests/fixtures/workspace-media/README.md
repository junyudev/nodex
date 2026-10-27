# Synthetic media fixtures

These six-second test patterns and sine waves exercise Electron decoding, metadata,
playback and seeking. No external media or user content is included.

Generated with FFmpeg using:

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v libvpx-vp9 -b:v 90k -g 10 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact vp9-opus.webm
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v libvpx -b:v 90k -g 10 -c:a vorbis -strict experimental -ac 2 -b:a 24k -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact vp8-vorbis.webm
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v libx264 -b:v 90k -g 10 -pix_fmt yuv420p -c:a aac -b:a 24k -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact h264-aac.mp4
```

The integration test generates its PCM WAV in memory.
