#!/bin/bash
echo "🔄 Menarik update terbaru dari GitHub..."
git checkout main
git pull origin main

if [ $? -eq 0 ]; then
    echo "✅ Repo lokal sudah sinkron dengan GitHub."
else
    echo "⚠️ Terjadi error saat sinkronisasi, cek pesan di atas."
fi
