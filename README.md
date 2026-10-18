# ES Obsidian Hub

**Notlarını yaz, istediğin notu board’a ekle, takvimini ve işlerini aynı yerde gör.**

Mac için hazır Obsidian başlangıç vault’u. Üç sütunlu kanban, Scratchpad ve Calendar / YouTrack / Slack kutuları birlikte gelir. Programlama bilgisi, Codex veya ücretli Obsidian Sync aboneliği gerekmez. Hesap bağlantıları isteğe bağlıdır.

**[Hazır vault’u indir](https://github.com/sariekr/es-obsidian-hub/releases/latest/download/es-obsidian-hub.zip)** · **[Hesapları bağla](docs/CONNECTIONS.md)** · **[Codex ile kur](AGENTS.md)** · **[Sorun giderme](docs/TROUBLESHOOTING.md)**

## İlk kurulum — daha önce Obsidian kullanmadıysan

1. [Obsidian’ı indir](https://obsidian.md/download) ve Applications klasörüne taşı. **1.11.4 veya daha yeni** bir sürüm kullan.
2. Yukarıdaki **Hazır vault’u indir** bağlantısından ZIP’i indir. Finder’da çift tıklayıp aç. Çıkan **es-obsidian-hub** klasörünü örneğin `Documents` içine taşı. Klasörün tamamını taşı; yalnızca `Hub` klasörünü seçme.
3. Obsidian’ı aç. **Open folder as vault → Open** seç. Az önce taşıdığın **es-obsidian-hub** klasörünü aç. “Vault”, notların ve ayarların bulunduğu bu klasör demek.
4. İlk açılışta kodu çalıştırmayı kabul ediyorsan **Trust author and enable plugins** seç. Açılan ayar penceresini kapat. Eklentilerin adları **Kanban Bases View** ve **ES Obsidian Hub**; ikisi de açık olmalı.
5. **Kanban Board** sekmesi hazır gelir. Üstte Scratchpad, altında Calendar / YouTrack / Slack ve **Backlog → In-Progress → Done** sütunlarını görmelisin. İlk etkinleştirmede kalabilen “Unknown view type” ekranı otomatik yeniden açılır. Yine de kalırsa sekmeyi kapatıp dosya listesinden `Hub → Kanban Board` dosyasını aç.

`.obsidian` gizli klasörü ZIP’in içindedir; Finder’da görmek için `Cmd+Shift+.` kullanabilirsin. Eklentileri mağazada arayıp tek tek indirmen gerekmez. **Trust** onayı Obsidian’ın kendi adımıdır; paket bunu atlatmaz. [Obsidian’ın vault açma](https://help.obsidian.md/manage-vaults) ve [eklenti etkinleştirme](https://help.obsidian.md/community-plugins) belgeleri.

> GitHub’daki **Code → Download ZIP** veya `git clone` da çalışır. En kolay yol yukarıdaki hazır vault ZIP’idir. Günlük notlarını bu public repoya push etme; kişisel vault’un yerel kalır.

## İlk iki dakikada dene

| Yapmak istediğin | Tıklayacağın yer |
| --- | --- |
| Hızlı bir düşünceyi saklamak | Üstteki **Scratchpad → Save**. Yeni, normal bir Quick Note oluşur. Yazmak veya pencereyi kapatmak tek başına not oluşturmaz. |
| Doğrudan bir kart oluşturmak | Backlog başlığındaki **Add note**. Yeni kart yazı sekmesinde açılır, board açık kalır. |
| Mevcut bir notu karta çevirmek | Notu aç → başlığın üstündeki **Add to board**. Yazın ve dosya konumu korunur. |
| Kartı board’dan kaldırmak | **Remove from board**. Not silinmez. |
| Durum, öncelik, tür veya etiket değiştirmek | Notun üstündeki **Status / Priority / Type / Tags**. Kartın sağ tık menüsü de kullanılabilir. |
| Notu klasöre çevirmek | **Make a folder**. Not ve ona ait içerik bir klasörde toplanabilir. |
| Notu silmek | En sağdaki ayrı **Delete note**. Obsidian’ın onay ve çöp kutusu akışı açılır. |
| Kutuları küçültmek veya gizlemek | Altlarındaki ayırıcıyı sürükle; **Customize** ile seç, **Hide widgets** ile gizle. Scratchpad görünür kalır. |

`Hub/Learning/Try Add to board.md` sıradan bir örnek nottur. Açıp **Add to board** ile dene. Board’daki iki örnek kartı da değiştirebilir veya silebilirsin. Kartları sürükleyerek sütun değiştirebilirsin; sütun içindeki sıra öncelik ve tarihe göre düzenlenir.

## Kendi klasörlerin

```text
Hub/
├── Kanban Board.base        # Ana ekran
├── Work/                    # Örnek iş alanı — değiştirilebilir
├── Personal/                # Örnek kişisel alan — değiştirilebilir
├── Learning/                # Örnek öğrenme alanı — değiştirilebilir
├── Quick Notes/             # Scratchpad ve Add note hedefi
├── YouTrack/                # Yalnızca seçerek aktardığın işler
├── Attachments/             # Ekler
├── _kanban/                 # Board şeması
└── _priority-seeds/         # Öncelik seçeneklerini korur
```

**Thesis, MSc veya bir şirkete ait notlarla gelmez.** `Work`, `Personal`, `Learning` örnektir. Obsidian dosya listesinde `Hub` altına örneğin `Projects` klasörü ekle; **Type** listesinde görünür. Kendi notlarını alt klasörlere yerleştirebilirsin. `Attachments`, `.` veya `_` ile başlayan klasörler Type sayılmaz.

**Type seçmek notu ilgili Hub klasörüne taşır.** Aynı Type’ı seçmek mevcut alt klasör yerleşimini korur. Klasör notlarında klasörün içeriği birlikte taşınır. Klasörü yeniden adlandırmak mevcut notların `category` değerlerini kendiliğinden yeniden yazmaz; gerekiyorsa notta Type’ı tekrar seç.

`Hub`, `Kanban Board.base`, `Quick Notes`, `Attachments`, `_kanban` ve `_priority-seeds` paket akışı için sabit yollardır. Bunları özelleştirmek istersen önce [AGENTS.md](AGENTS.md) içindeki kod haritasını kullan. Board üyeliği Hub içindeki `kanban` etiketidir; dosya başına ayrı kart veritabanı yoktur.

## Kendi hesapların

| Bağlantı | Gereken | Kurulum yeri |
| --- | --- | --- |
| Google Calendar | Kendi Google hesabın ve Desktop OAuth istemcisi; uygun hesaplarda özel iCal adresi de kullanılabilir | **Connect Google Calendar** |
| YouTrack | Kendi sunucun, login’in, proje anahtarın, permanent token ve **Python 3.11+**; sunucuda `/mcp` desteği | **YouTrack settings** |
| Slack | Workspace’inin onayladığı Slack uygulaması ve kendi **User OAuth Token**’ın | **Connect Slack**; not kanalı ve kullanıcı grubu isteğe bağlı |

Adım adım anlatım: **[Hesap bağlantıları](docs/CONNECTIONS.md)**. Board, not araçları, Scratchpad, takvim ve Slack için Python/Node/npm kurulmaz. Python yalnızca YouTrack yardımcısına gerekir. Codex, Claude veya MCP istemcisi kurulumu gerekmez; yardımcı doğrudan senin YouTrack sunucunun MCP uç noktasını kullanır.

YouTrack’in **remote status sync** seçeneği başlangıçta kapalıdır. Açarsan seçerek aktardığın kartı bir sütuna taşımak uzaktaki issue’nun **State** alanını da değiştirir; Done’dan çıkarmak işi yeniden açabilir. Hangi sütunun hangi State’e karşılık geldiğini sen belirlersin. Açılışta toplu eşitleme yapılmaz. **Refresh** yalnızca listeyi okur.

## Güncelleme ve verilerin

Bu depo bir başlangıç şablonudur. Günlük kullanımda yazdıkların Markdown dosyaları olarak kendi vault’unda kalır. Tokenlar cihazın **Obsidian Keychain** alanındadır; repo veya not dosyalarında saklanmaz. Slack mesajları ve takvim etkinlikleri bellektedir. YouTrack listesi yerel bir JSON önbelleğine, seçerek aktardığın işler ve ekler vault’a kaydedilir.

Yeni sürümde önce vault’unu yedekle ve Obsidian’ı kapat. [Güncelleme rehberini](docs/UPDATING.md) izle; yeni ZIP’i kullandığın vault’un tamamının üzerine açma. Her Mac’te hesaplarını yeniden bağla. Scratchpad taslağı cihaz yerelidir; cihaz değiştirmeden **Save** kullan.

## Codex’e verilecek kısa istek

```text
Bu repodaki AGENTS.md ve README.md dosyalarını oku.
Mac’imde ES Obsidian Hub’ı ayrı, yeni bir vault olarak kur.
Mevcut notlarımın veya Obsidian ayarlarımın üzerine yazma.
Board’un açıldığını ve Add to board / Scratchpad’i örnek notlarla doğrula.
Hesaplarımı bağlantı rehberine göre benim gireceğim yerel alanlarla kur;
token veya OAuth JSON içeriğini sohbete isteme.
```

## Sürüm ve katkı

İlk paylaşılabilir sürüm: **1.0.0**. Mac masaüstü için hazırlanmıştır. Windows, Linux ve mobil bu sürümün doğrulama kapsamına dahil değildir. Eklenti mağazasında bağımsız yayımlanmış bir ürün değildir; hazır vault ile gelir.

[Doğrulama kaydı](docs/VERIFICATION.md) ve [bakım talimatları](AGENTS.md). Üçüncü taraf bileşenler kendi lisanslarıyla dağıtılır: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). ES Hub kodu ve başlangıç belgeleri MIT lisanslıdır.
