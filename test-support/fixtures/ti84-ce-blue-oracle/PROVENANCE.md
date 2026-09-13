# TI-84 Plus CE blue screenshot oracle

These two files were copied verbatim from a retained capture set. They were
captured live from a TI-84 Plus CE on 2026-08-29 displaying a blue-line
parabola. The graph was chosen because the earlier
retained CE screen contains only white, grey, black, and green: that population
cannot distinguish the RGB565 red and blue masks.

| retained artifact | bytes | SHA-256 |
|---|---:|---|
| `ce-blue.pcap` | 212,767 | `085c59b65c76e1b874dabb7d24b1629bec0e8d39ad4fd702b8f7eab842664158` |
| `ce-blue-parabola.bmp` | 153,666 | `f13a25cc9c310ce2fc8dea0246c5fd3b291bc83de6804dc317d071678aac38b0` |

The pcap is the independent decoder input. The BMP is retained as companion
product output and is never fed to the control. The control reconstructs the
calculator-to-host response bytes directly from the pcap's USB bulk-IN
completions, admits the CE module and runs its authored Lua export, then
decodes the resulting pixels through the BMP's declared masks. The measured
population is 388 pure-blue pixels and zero pure-red pixels; swapping the masks
makes the same wire pixels pure red.
