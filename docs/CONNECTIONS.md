# Kendi hesaplarını bağlama

Hesap kurmadan board’u kullanabilirsin. Hiçbir bağlantıda paket sahibinin hesabı kullanılmaz. Tokenlar ve OAuth istemci dosyaları yalnızca Obsidian’ın yerel bağlantı penceresine girilir. Bunları notlara, GitHub’a veya Codex sohbetine yapıştırma.

## Google Calendar

Bu sürüm Google hesabının **primary** takvimini okur; başka bir takvimi seçme arayüzü yoktur. Agenda’daki Google Meet ve Zoom bağlantıları toplantıyı açar. Etkinlik oluşturmaz veya değiştirmez.

### Desktop Google sign-in

1. Tarayıcıda kendi hesabınla [Google Cloud Console](https://console.cloud.google.com/) aç. Bir proje oluştur veya hesabın için ayrılmış mevcut projeyi seç.
2. **APIs & Services → Library → Google Calendar API → Enable**.
3. **Google Auth platform → Branding / Audience** altında uygulamayı yapılandır. Workspace içinde kullanılacaksa uygun olduğunda **Internal** seç. Kişisel Gmail hesabında **External** ve test aşamasındaysan kendi hesabını test kullanıcılarına ekle. Workspace yöneticisi uygulamaya izin vermek zorunda olabilir.
4. **Clients → Create Client → Desktop app** seç. İstemci JSON dosyasını bilgisayarına indir. Vault dışında tut; paylaşma.
5. Hub’da **Connect Google Calendar → Google sign-in · desktop → Import client JSON** ile bu dosyayı seç. Ardından **Sign in with Google**.
6. Tarayıcıda kendi hesabınla salt okunur izni ver. Obsidian’a dön; pencere kendi kendine kapanana kadar bekle. İlk ay okuması başarılı olmadan bağlantı kaydedilmez.
7. **Agenda** seçip etkinliklerinin geldiğini kontrol et. Obsidian’ı yeniden açınca bağlantının geri geldiğini doğrula.

İstenen izin: `calendar.events.owned.readonly`. Access token ve etkinlikler bellekte; istemci bilgileri ve refresh token Obsidian Keychain’dedir. Açık ve görünür takvim yaklaşık beş dakikada bir yenilenir. [Google’ın Desktop OAuth kurulumu](https://developers.google.com/workspace/calendar/api/quickstart/python) bu projedeki istemci hazırlığını açıklar; oradaki Python kodunu veya pip paketlerini kurman gerekmez.

Google, External uygulamaların test modundaki refresh tokenlarını sınırlayabilir. Bağlantı sonradan düşerse yeniden sign-in yap ve Google projesinin yayın/kurum politikasını kontrol et. Uygun yayın durumu için [Google OAuth rehberini](https://developers.google.com/identity/protocols/oauth2) izle.

### Özel iCal alternatifi

Google Calendar’ın ayarlarında **Settings for my calendars → Integrate calendar → Secret address in iCal format** gerçekten mevcutsa, Hub’daki **Private iCal link** seçeneğine gir. Workspace hesabında bu alan kapatılmış olabilir; bu durumda OAuth kullan. Takvimini public yapman gerekmez. Özel iCal adresi de bir sırdır; yalnızca yerel maskeli alana gir.

**Disconnect** bu cihazdaki bağlantıyı kaldırır. Google tarafındaki yetkiyi ayrıca kaldırmak için bağlantı penceresindeki Google account permissions bağlantısını kullan.

## YouTrack

### Gerekenler

- YouTrack sunucunun HTTPS adresi ve `/mcp` desteği. Bu sürüm kök adreste çalışan sunucular içindir; özel port veya `/youtrack` gibi alt yol desteklenmez.
- Kendi **login** değerin; görünen adınla aynı olmak zorunda değil.
- Tek bir projenin kısa anahtarı: örneğin `TEAM`.
- Kendi hesabından üretilmiş **permanent token**, kapsamı **YouTrack**.
- Mac’te **Python 3.11+**. Yoksa [python.org macOS installer](https://www.python.org/downloads/macos/) ile kur. Eklenti önce `/opt/homebrew/bin/python3`, yoksa `/usr/local/bin/python3` kullanır. İlk bulunan sürüm eskiyse onu güncelle. Sistem Python’u tek başına yeterli olmayabilir; pip paketi gerekmez.

YouTrack profilinde **Account Security → Tokens / New token** bölümünden token oluştur. Yönetici bu özelliği sınırlamış olabilir. [JetBrains’in permanent token kılavuzu](https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html) ve [MCP sunucu belgesi](https://www.jetbrains.com/help/youtrack/cloud/model-context-protocol-server.html).

### Bağlama

1. Hub’da **YouTrack settings** aç.
2. **Server**: `company.youtrack.cloud` biçiminde kendi sunucun.
3. **Your login**: kendi login’in. **Project key**: kendi projenin anahtarı.
4. **Permanent token**: tokenı yerel maskeli alana gir.
5. İlk kullanımda **Board status sync** kapalı kalsın. **Connect** seç.
6. Kimlik ve liste doğrulanınca pencere kapanır. **Refresh** ile sana atanmış açık işleri yenile. Liste otomatik ağ sorgusuyla yenilenmez.

Bu sürüm MCP yanıtında **Assignee, State ve Priority** alanları olan projeler için hazırlanmıştır. State seçenekleri farklı olabilir; eşitleme ayarından değiştirilir. Çoklu assignee veya farklı alan şemaları hata verebilir; [AGENTS.md](../AGENTS.md) uyarlama sınırlarını açıklar. Özel karakterli login’lerde desteklenen biçim harf/rakam ve `_ . @ + -` karakterleridir. `Connect` sonrasında boş liste görmek, projenin gerçekten boş olduğunun tek başına kanıtı değildir; anahtarı ve issue görünürlüğünü de kontrol et.

### Yerel kopya ve isteğe bağlı State eşitleme

Widget’taki bir işi board sütununa sürükle veya sağ tık → **Add to …** seç. Tam açıklama, mevcut yorumlar ve izin verilen boyuttaki ekler `Hub/YouTrack` ve `Hub/Attachments/YouTrack` altında yerel kopyaya alınır. Tekrar aktarmak aynı kartı kullanır. **My notes** bölümüne yazabilirsin; Refresh yazdıklarını değiştirmez.

**Board status sync → Enable remote status changes** seçilirse üç sütunun State karşılığını tanımla. Örneğin `Open / Doing / Closed`. Kaydetmek mevcut kartları topluca değiştirmez. Sonraki seçili aktarma ve sütun değişiklikleri yalnızca o işin **State** alanına yazar. Açıklama, yorum veya worklog göndermez. Bir hata olursa kart yerelde kalır; **Retry** ile güncel yerel sütunu tekrar denersin. Belirsiz yazılar kendiliğinden tekrarlanmaz.

Token ve profil Obsidian Keychain’dedir. Python’a yalnızca bir işlem süresince stdin üzerinden iletilir; komut satırına, ortama veya Codex/Claude ayar dosyalarına konmaz. Snapshot `youtrack-widget.json` yerel dosyasıdır ve Git’ten dışlanır. Başka sunucudaki aynı issue ID’sine ait eski bir yerel kopya varsa, bunu karıştırmak yerine aktarım durur; eski kopyayı Hub dışına taşı veya ayrı vault kullan.

## Slack

Slack kutusu gelen birebir DM’leri, sana yapılan mention’ları ve seçersen bir not kanalı ile bir kullanıcı grubunu okur. **Senin attığın DM’ler** DM görünümüne dahil değildir. Grup DM’leri dahil değildir. Bu bir okunmamış mesaj sayacı veya tam arşiv değildir.

1. [Slack app yönetiminde](https://api.slack.com/apps) kendi workspace’in için bir uygulama oluştur veya yöneticinin onayladığı uygulamayı kullan. **From scratch** yeterlidir; bot, server veya event subscription gerekmez.
2. **OAuth & Permissions → User Token Scopes** altında `search:read`, `users:read`, `im:read`, `im:history` ekle. **Bot Token Scopes** bölümünü kullanma.
3. Not kanalı istiyorsan `channels:read`, `channels:history` ekle. Kanal private ise ayrıca `groups:read`, `groups:history` gerekir.
4. Kullanıcı grubu istiyorsan `usergroups:read` ekle. Workspace’inin bu özelliği desteklemesi ve senin grupta olman gerekir.
5. **Install to Workspace** veya kapsam değiştiyse **Reinstall to Workspace** seç. Workspace yöneticisinin onayı gerekebilir. **User OAuth Token** (`xoxp-…`) değerini kendi bilgisayarında kopyala.
6. Hub’da **Connect Slack** aç. Tokenı maskeli alana gir. **Notes channel** alanına istersen katıldığın kanalın adını, **User group** alanına istersen grubun handle’ını yaz. Örnekler: `my-notes`, `design-team`. Alanları boş bırakabilirsin; baştaki `#` / `@` temizlenir.
7. **Connect Slack** seç. Hesap, seçtiğin kaynaklar ve Keychain kaydı doğrulanınca mesajlar açılır. Bağlantı varken kaynakları değiştirmek için ayarları aç; token alanını boş bırakırsan mevcut token korunur.

**All / DMs / @Me** ve yapılandırdıysan **#Notes / @Group** filtreleri vardır. Son yedi günün, kaynak başına en yeni 50 sonucu birleştirilir; her filtre en fazla 50 satır gösterir. Açık ve görünür widget yaklaşık beş dakikada bir yenilenir; Slack’in hız sınırı varsa bekler. Sınırlamalar **Slack settings → Inbox details** içindedir.

Slack’in `search.messages` erişimi, uygulama politikası ve workspace arama davranışı sonucu etkileyebilir. Kurum bu API’ye izin vermiyorsa yalnızca daha fazla kapsam eklemek sorunu çözmeyebilir. [Slack uygulama kurulumu](https://docs.slack.dev/quickstart/) ve [search.messages sınırları](https://docs.slack.dev/reference/methods/search.messages/).

**Disconnect** yerel tokenı ve bellekteki mesajları kaldırır; Slack tarafındaki uygulama yetkisini iptal etmez. Sunucu tarafında kaldırmak için Slack’in uygulama yönetimini kullan. İkinci Mac’te ayrı bağlan; Keychain’i vault içine dışa aktarma.
