# Kurulumda takılırsan

| Belirti | Kontrol |
| --- | --- |
| Board yerine normal notlar veya boş ekran | Açtığın vault klasöründe gizli `.obsidian` var mı? `Hub/Kanban Board.base` dosyasını aç. |
| `Unknown view type: kanban-view` | **Settings → Community plugins** altında iki eklenti de açık mı? İlk güven onayından sonra ayarları kapat. Otomatik toparlanmazsa board sekmesini kapatıp yeniden aç. |
| Home veya Add to board yok | **ES Obsidian Hub** açık mı? Aynı isimli başka vault veya farklı config folder açmış olabilir misin? Board görünümü `Board` olmalı. |
| Eklenti yüklenemedi | Paketin `.obsidian` klasörünü eksik kopyalamış olabilirsin. Denetleyiciyi çalıştır. Kaynak dosyalar eksikse temiz ZIP’i yeni klasöre aç. |
| Notun Add to board düğmesi pasif | Not `Hub` altında olmalı. README/AGENTS gibi kök belgeler board üyeliği için kapsam dışında. |
| Remove from board sonrası hâlâ görünüyor | Notun gövdesinde `#kanban` etiketi olabilir. Eklenti gövdeyi sessizce değiştirmez; etiketi kendin kaldır. |
| Type listesindeki klasör kayboldu | Yalnızca Hub’ın doğrudan alt klasörleri Type olur. Utility klasörleri ve dosyalar Type değildir. |
| Done kartı bir süre sonra görünmüyor | Ana Board, tamamlanma tarihinden yedi gün sonra tamamlanan kartları gizler. **Customize → Show board controls → By Status** ile bulabilirsin. Dosya silinmez. |
| Sütunlar dar veya yana kayıyor | Dar pencerede widget’lar yatay kayar. Pencereyi büyüt; widget altındaki ayırıcıyı yukarı çek. Mac ekranının yüksekliğine göre görünen kart sayısı değişir. |
| YouTrack Python hatası | `python3 scripts/check-setup.py` çalıştır. İlk bulunan `/opt/homebrew/bin/python3` veya `/usr/local/bin/python3` sürümünün 3.11+ olması gerekir. |
| YouTrack kimlik hatası | Görünen ad yerine tam login kullan. Token aynı kullanıcıya ait ve YouTrack kapsamlı olmalı. |
| YouTrack boş | Proje anahtarını, sana atanmış unresolved işleri ve sunucunun MCP görünürlük ayarlarını kontrol et. Boş liste yanlış proje anahtarıyla da ilişkili olabilir. |
| State değişmiyor | Başlangıçta eşitleme kapalıdır. İstersen **YouTrack settings → Board status sync** içinde etkinleştir ve sunucudaki gerçek State adlarını yaz. Yalnızca yeni sütun değişiklikleri veya açık Sync status eylemi yazar. |
| Google 403 / API disabled | OAuth istemcisinin ait olduğu projede Calendar API açık mı? Workspace yöneticisi izin veriyor mu? |
| Slack missing scope | Gerekli izinleri **User Token Scopes** içine ekle ve uygulamayı workspace’e yeniden kur. Yeni User OAuth Token ile bağlan. |
| Slack kanal/grup bulunamadı | Kanal üyesi ve seçilen kullanıcı grubunun üyesi olmalısın. İstemiyorsan ilgili alanı boş bırak. Kanal adı/handle gir; görünen başlık veya kanal URL’si değil. |
| İkinci Mac’te hesaplar yok | Her Mac’te ayrı bağlan. Vault kopyalamak Keychain bağlantısını taşımak değildir. |
| Scratchpad metni kaybolmasın | Cihaz değiştirmeden Save seç. Taslak yerel kurtarma içindir; Sync ile taşınmaz. |

Dosya kontrolü Terminal’den, vault klasöründe:

```sh
python3 scripts/check-setup.py
```

Bu komut şifre okumaz, ağa bağlanmaz, dosya değiştirmez. Hata durumunda sonucu Codex’e gösterebilirsin. Token/OAuth JSON veya özel mesaj ekran görüntüsü ekleme. [Kurulum talimatı](../AGENTS.md) mevcut notları koruyarak ilerlemeyi anlatır.
