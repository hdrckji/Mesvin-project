/* ============================================================================
   Bible Horizon — l'unique activité de la coquille WebView.

   Le site biblehorizon.fr reste la seule application ; ce fichier ne fait
   que l'afficher dans la WebView du système (et non plus dans Chrome comme
   la TWA), pour que l'activité des utilisateurs soit attribuée à l'appli.

   Ce qu'il gère, et rien de plus :
   - le domaine reste dans l'appli, tout lien externe part vers le navigateur ;
   - le bouton retour remonte l'historique du site avant de quitter ;
   - sans réseau au lancement, une page d'attente locale avec « Réessayer » ;
   - les raccourcis et liens profonds (« Lire », « Défi ») ouvrent leur URL ;
   - l'agent utilisateur porte la marque « BibleHorizonApp » : le site s'en
     sert pour taire ce qui n'a plus de sens dans l'appli (l'appel aux
     testeurs, l'invite d'installation).
   ========================================================================== */
package fr.biblehorizon.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

  private static final String ACCUEIL = "https://biblehorizon.fr/";
  private WebView web;
  private String derniereUrl = ACCUEIL;

  @Override
  protected void onCreate(Bundle etat) {
    super.onCreate(etat);

    web = new WebView(this);
    setContentView(web);

    WebSettings p = web.getSettings();
    p.setJavaScriptEnabled(true);
    p.setDomStorageEnabled(true);
    p.setUserAgentString(p.getUserAgentString() + " BibleHorizonApp/2");

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView vue, WebResourceRequest demande) {
        Uri url = demande.getUrl();
        if (estChezNous(url)) return false; // la WebView s'en charge
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (Exception e) { /* aucune appli pour ce lien : on l'ignore */ }
        return true;
      }

      @Override
      public void onReceivedError(WebView vue, WebResourceRequest demande, WebResourceError erreur) {
        // Seule la page principale compte : une image manquante ne doit pas
        // faire tomber tout l'écran.
        if (demande.isForMainFrame()) {
          derniereUrl = demande.getUrl().toString();
          vue.loadUrl("file:///android_asset/hors-ligne.html");
        }
      }
    });

    if (etat != null) {
      web.restoreState(etat);
    } else {
      web.loadUrl(urlDemandee(getIntent()));
    }
  }

  /* Le seul juge de ce qui se charge dans la WebView : https, et l'hôte est
     biblehorizon.fr ou l'un de ses sous-domaines. Une comparaison de PRÉFIXE
     ne suffit pas — « https://biblehorizon.fr.pirate.example » commencerait
     par la bonne chaîne : c'est exactement la faille de cross-app scripting
     que Google a signalée (un intent peut venir de n'importe quelle appli). */
  private static boolean estChezNous(Uri url) {
    if (url == null || !"https".equals(url.getScheme())) return false;
    String hote = url.getHost();
    if (hote == null) return false;
    return hote.equals("biblehorizon.fr") || hote.endsWith(".biblehorizon.fr");
  }

  /* Raccourci, lien profond, ou simple lancement : quelle page ouvrir ? */
  private String urlDemandee(Intent intent) {
    if (intent != null && estChezNous(intent.getData())) {
      return intent.getData().toString();
    }
    return ACCUEIL;
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    // On ne navigue que vers une URL vérifiée du site : un intent hostile
    // ne peut au pire que ramener à l'accueil.
    if (estChezNous(intent.getData())) web.loadUrl(intent.getData().toString());
  }

  @Override
  public void onBackPressed() {
    // Depuis la page d'attente locale, retenter le site plutôt que l'historique.
    String courante = web.getUrl();
    if (courante != null && courante.startsWith("file://")) {
      web.loadUrl(derniereUrl);
      return;
    }
    if (web.canGoBack()) {
      web.goBack();
    } else {
      super.onBackPressed();
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle etat) {
    super.onSaveInstanceState(etat);
    web.saveState(etat);
  }

  @Override
  protected void onDestroy() {
    if (web != null) web.destroy();
    super.onDestroy();
  }
}
