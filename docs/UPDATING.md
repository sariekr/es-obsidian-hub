# Güncelleme

Bu paket bir şablondur; günlük notlarına otomatik güncelleme uygulamaz.

1. Scratchpad taslağını **Save** ile nota dönüştür. Sync kullanıyorsan bitmesini bekle.
2. Vault klasörünün tamamını yedekle. Sonra Obsidian’ı kapat.
3. Yeni release ZIP’ini **başka bir klasöre** aç. Sürüm notlarını ve `docs/VERIFICATION.md` dosyasını oku.
4. Genel bir Extras güncellemesinde yalnızca `.obsidian/plugins/aimultiple-kanban-extras/` altındaki kod, manifest, CSS ve yardımcı script dosyalarını değiştir. Kendi **data.json** ayarlarını ve **youtrack-widget.json** snapshot’ını koru. Klasörün tamamını silip değiştirme.
5. `Hub`, `Templates`, `.obsidian/workspace.json`, `app.json`, `appearance.json`, board/taxonomy veya kendi dosyalarının üzerine şablon kopyalama. Yeni bir sürüm bu alanlarda değişiklik gerektiriyorsa dosya farklarını tek tek inceleyerek uygula.
6. Vendor eklenti veya tema güncellemesini sürüm notları istemedikçe ayrıca yapma. Extras bazı upstream DOM seçicilerine bağlıdır.
7. Obsidian’ı aç; board ve not araçlarını kontrol et. YouTrack’te sırf test için gerçek State değiştirme. Bir sorun varsa yedekten yalnızca değiştirdiğin kodu geri al.

`scripts/install.py` yalnızca yeni ve boş hedeflere kurulum yapar; güncelleme aracı değildir. Kişisel vault’u public GitHub’a push ederek güncelleme alma. Ayrı bir kaynak checkout’u ve ayrı bir kişisel vault kullan.

`distribution.json` başlangıç paketinin hash’lerini kaydeder. Bir sürümü bilinçli güncellediğinde yeni runtime hash’lerini içeren denetleyici/manifesti de taşı. Kullanıcının değiştirdiği örnek notları eski hash’lere döndürme; normal `check-setup.py` kişisel notların içeriğini denetlemez.
