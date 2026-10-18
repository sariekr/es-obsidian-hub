# 1.0.0 doğrulama kaydı

Tarih: **18 Ekim 2026**. Bu kayıt paylaşılan başlangıç paketine aittir.

## Kod ve paket

- **179 Node testi, 21 Python testi geçti.** Board üyeliği, not taşıma/koruma, Scratchpad, takvim, Slack, YouTrack okuma/aktarma/durum değişikliği testleri sentetik verilerle çalışır.
- Yeni taşınabilir profil testleri başka sunucu/kullanıcı/proje ve State adlarını, bağlantısız çalışma, kapalı varsayılan State eşitlemesi, isteğe bağlı Slack kaynakları ve Keychain profil değişikliklerini kapsar. Bağlantı kontrolü sürerken yeni import/State işlemleri engellenir.
- İlk güven onayında kalabilen `Unknown view type: kanban-view` durumu testle yakalandı; yalnızca ana dashboard sekmesini yeniden açan düzeltme eklendi.
- Dağıtım dosyaları `distribution.json` içinde tek tek listelenir ve SHA-256 ile denetlenir. Kaynak notlardan/snapshotlardan toplu kopya yapılmadı. Yayın ZIP’i yalnızca bu listedeki dosyaları içerir.
- **3 paket testi geçti:** boş hedefe kurulum, dolu/symlink hedefin reddi, değiştirilmiş runtime dosyasının tespiti ve listede olmayan dosyaların ZIP’e alınmaması. ZIP iki kez üretilip aynı SHA-256 sonucu doğrulandı.
- Kanban Bases View 0.9.5 dosyaları resmi release ile, AnuPpuccin CSS’i v1.5.0 kaynak etiketiyle eşleştirildi. Lisanslar ve tema kaynak arşivi dahildir.

## Gerçek Obsidian

Mac’te Obsidian **1.11.7**, ayrı ve temiz bir test vault’u, sentetik örnek notlar kullanıldı. Kişisel vault veya gerçek servis hesabı test verisi olarak kullanılmadı.

- Klasör açıldığında ana Board sekmesi hazır geldi. Kullanıcının açık güven onayıyla eklentiler etkinleştirildi.
- İlk açılışta görülen bilinmeyen kanban görünümü yeniden üretildi. Eklentileri UI’dan etkinleştirdikten sonra düzeltmenin dashboard’u elle dosya açmadan geri getirdiği doğrulandı.
- `Try Add to board` notu board’a eklendi ve çıkarıldı. İçeriği ve dosya konumu korundu; dosyadan geri okundu.
- Scratchpad’e iki satır yazmak dosya oluşturmadı. Save tam metinle bir sıradan Quick Note oluşturdu; board açık kaldı.
- Status/Priority/Type/Tags/Other properties, Make a folder ve ayrı Delete araçlarının varlığı görüldü.
- YouTrack bağlantı alanları ve kapalı varsayılan State eşitlemesi yerel modalda görüldü.

## Sentetik tarayıcı önizlemesi

Gerçek runtime, vendor ve tema CSS’i ile mock Obsidian/Slack API’leri kullanıldı. Önizleme kendi DOM denetimlerini **PASS** olarak tamamladı: Scratchpad Save/hata/retry/çift tıklama/tam içerik/kurtarma ve gizli widget davranışı; Slack kaynak/filtre/sınır/otomatik yenileme davranışları. Masaüstü koyu tema, 800px açık panel ve YouTrack bağlantı formu görsel olarak incelendi.

## Kapsam dışı

Bu public sürüm için gerçek Google/Slack/YouTrack hesabıyla yeni giriş, gerçek YouTrack State yazısı, arkadaşların Mac’leri, Intel Mac, mobil veya Windows/Linux doğrulanmadı. Gerçek hesap bağlantısını her kullanıcı kendi cihazında tamamlamalı. Google/Slack kurum izinleri ve YouTrack sunucusunun MCP/alan şeması uyumu ayrıca gerekir. Kod testleri canlı servis testinin yerini tutmaz.

Son profil eşzamanlılık korumaları Node testlerinde, son checkbox düzeni gerçek-runtime tarayıcı önizlemesinde doğrulandı; bu son küçük değişiklikler için native test dizisinin tamamı yeniden yapılmadı. Upstream Obsidian/kanban DOM değişiklikleri seçicileri etkileyebilir.
