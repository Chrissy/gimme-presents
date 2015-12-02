class Users::OmniauthCallbacksController < Devise::OmniauthCallbacksController
  def google_oauth2

    if current_user
      @user = current_user.add_omniauth_data(request.env["omniauth.auth"])
    else
      @user = User.find_with_omniauth(request.env["omniauth.auth"])
    end

    if @user
      flash[:notice] = "success!"
      sign_in_and_redirect @user, :event => :authentication
    end
  end
end
