# Third-party notices

Tvine ships the following third-party material.

## Common-passwords list

`warp/data/common-passwords.txt.gz` (the list `tvine.auth` uses to refuse common passwords) comes from the Django
project and is distributed under its BSD license:

```
Copyright (c) Django Software Foundation and individual contributors.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    1. Redistributions of source code must retain the above copyright notice,
       this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
       notice, this list of conditions and the following disclaimer in the
       documentation and/or other materials provided with the distribution.

    3. Neither the name of Django nor the names of its contributors may be used
       to endorse or promote products derived from this software without
       specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## World map

`admin/dist/shield/shield.js` contains country outlines derived from Natural Earth 110m admin-0 data
(https://www.naturalearthdata.com), which is in the public domain.

## IP database (downloaded, not shipped)

`tvine.shield` downloads the DB-IP Lite country and ASN databases at run time (https://db-ip.com), licensed under
Creative Commons Attribution 4.0 International (CC BY 4.0). A site that shows data from them should credit
"IP Geolocation by DB-IP".

## Bundled libraries

The admin and Shield panel bundles include React, CodeMirror and other MIT-licensed packages; their license
notices are kept in the bundled files. Runtime dependencies are installed from npm with their own licenses.
